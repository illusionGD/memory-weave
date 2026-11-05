import { API_CODES } from '@memory-weave/contracts';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { createPool } from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';
import { mysqlConnectionOptions } from './connection';
import { SERVER_CONFIG } from '../config';
import type { RuntimeConfig } from '../config';
import { querySchemaStatus } from './migrations';
import * as schema from './schema';
import { DatabaseContext } from './database-context';
import { DatabaseTables } from './tables';
import type { MySqlTransactionConfig } from 'drizzle-orm/mysql-core';
import { ApiException } from '../http/api-exception';

/** 原始 Drizzle 查询连接，供基础实现和显式 SQL 使用。 */
export type SqlDatabase = MySql2Database<typeof schema>;

/** 事务回调使用同一连接，适用于发布序号与幂等结果的原子提交。 */
export type SqlTransaction = Parameters<Parameters<SqlDatabase['transaction']>[0]>[0];

/** 已带持久归属的普通数据库入口。 */
export type Database = DatabaseContext<SqlDatabase>;
/** 已带持久归属且使用独立连接的事务入口。 */
export type DatabaseTransaction = DatabaseContext<SqlTransaction>;
/** 业务查询接受普通上下文或当前事务。 */
export type QueryDatabase = Database | DatabaseTransaction;

/** 为业务提供当前部署归属、结构状态和脱敏后的数据库错误。 */
@Injectable()
export class DatabaseService extends DatabaseTables<SqlDatabase> implements OnApplicationShutdown {
  private readonly pool: Pool;
  private readonly sql: SqlDatabase;

  /** 初始化数据库连接与查询服务。 */
  constructor(@Inject(SERVER_CONFIG) config: RuntimeConfig) {
    super((operation) => this.withOwner((ownerId, database) => operation(database.sql, ownerId)));
    this.pool = createPool({
      ...mysqlConnectionOptions(config.databaseUrl),
      connectionLimit: 4,
      maxIdle: 4,
      idleTimeout: 10_000,
      queueLimit: 32,
    });
    this.sql = drizzle(this.pool, { schema, mode: 'default' });
  }

  /**
   * 查询数据库迁移的就绪状态。
   *
   * 只读检查当前迁移与数据库历史是否一致，不在健康检查中执行 DDL。
   */
  async getSchemaStatus(): Promise<{
    status: 'ready' | 'pending' | 'unavailable';
    version: string | null;
  }> {
    return querySchemaStatus(this.pool);
  }

  /**
   * 取得部署管理者并执行领域操作。
   *
   * 从持久配置取得部署管理者，再执行带归属限制的领域操作。
   * @param operation 基础 CRUD 已限定 ownerId，使用 sql 的领域查询仍须明确限定归属。
   * @returns 已完成的领域操作结果；不向 HTTP 返回驱动异常与连接信息。
   */
  async withOwner<T>(operation: (ownerId: string, db: Database) => Promise<T>): Promise<T> {
    try {
      const status = await this.getSchemaStatus();
      if (status.status !== 'ready') {
        throw new ApiException(API_CODES.DATA_UNAVAILABLE);
      }
      const [owner] = await this.sql
        .select({ id: schema.owners.id })
        .from(schema.owners)
        .where(eq(schema.owners.deploymentKey, 'local'))
        .limit(1);
      if (!owner) throw new ApiException(API_CODES.DATA_UNAVAILABLE);
      return await operation(owner.id, new DatabaseContext(this.sql, owner.id));
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const code = databaseErrorCode(error);
      if (code === 'ER_DUP_ENTRY') throw new ApiException(API_CODES.CONFLICT);
      if (
        [
          'ER_NO_REFERENCED_ROW_2',
          'ER_ROW_IS_REFERENCED_2',
          'ER_CHECK_CONSTRAINT_VIOLATED',
          'ER_BAD_NULL_ERROR',
          'ER_DATA_TOO_LONG',
          'WARN_DATA_OUT_OF_RANGE',
          'ER_TRUNCATED_WRONG_VALUE',
          'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
        ].includes(code ?? '')
      ) {
        throw new ApiException(API_CODES.DATA_CONSTRAINT_VIOLATION);
      }
      if (code) throw new ApiException(API_CODES.DATA_UNAVAILABLE);
      // 无法识别为数据库错误的异常交给全局 500 处理，避免掩盖业务代码缺陷。
      throw error;
    }
  }

  /** 在持久归属下执行事务，回调内直接使用 tx.表.操作。 */
  transaction<R>(
    operation: (tx: DatabaseTransaction) => Promise<R>,
    options?: MySqlTransactionConfig,
  ): Promise<R> {
    return this.withOwner((_ownerId, database) => database.transaction(operation, options));
  }

  /**
   * 关闭应用使用的数据库连接池。
   *
   * 应用关闭时释放业务连接，不影响其他服务持有的连接。
   */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * 从数据库异常及其原因中提取错误代码。
 *
 * Drizzle 会把驱动异常放在 cause 中，只提取受控分类所需的错误代码。
 */
function databaseErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object') return undefined;
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}
