import { API_CODES } from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
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
import { IdentityContext } from './identity-context';
import type { ExecutionIdentity } from './identity-context';
import { ApiException, databaseOperation } from '../http/api-exception';

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
  private shutdown: Promise<void> | undefined;
  private readonly contexts = new WeakMap<ExecutionIdentity, Promise<Database>>();

  /** 初始化数据库连接与查询服务。 */
  constructor(
    @Inject(SERVER_CONFIG) config: RuntimeConfig,
    @Inject(IdentityContext) readonly identity = new IdentityContext(),
  ) {
    super(async (operation) => {
      const database = await this.current();
      return databaseOperation(() => operation(database.sql, database.ownerId));
    });
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

  /** 取得本次执行已校验的数据库入口，多个查询共用一次结构检查。 */
  async current(): Promise<Database> {
    const identity = this.identity.require();
    let current = this.contexts.get(identity);
    if (!current) {
      current = databaseOperation(async () => {
        const status = await this.getSchemaStatus();
        if (status.status !== 'ready') throw new ApiException(API_CODES.DATA_UNAVAILABLE);
        return new DatabaseContext(this.sql, identity.ownerId, (operation, options) =>
          this.executeTransaction(identity.ownerId, operation, options),
        );
      });
      this.contexts.set(identity, current);
    }
    return current;
  }

  /** 为部署身份适配器读取持久身份，普通业务不得用它代替认证。 */
  resolveDeploymentOwner(deploymentKey: string): Promise<string> {
    return databaseOperation(async () => {
      if ((await this.getSchemaStatus()).status !== 'ready')
        throw new ApiException(API_CODES.DATA_UNAVAILABLE);
      const [owner] = await this.sql
        .select({ id: schema.owners.id })
        .from(schema.owners)
        .where(eq(schema.owners.deploymentKey, deploymentKey))
        .limit(1);
      if (!owner) throw new ApiException(API_CODES.DATA_UNAVAILABLE);
      return owner.id;
    });
  }

  /** 在当前身份下执行独立事务，成功提交，异常回滚。 */
  async transaction<R>(
    operation: (tx: DatabaseTransaction) => Promise<R>,
    options?: MySqlTransactionConfig,
  ): Promise<R> {
    return (await this.current()).transaction(operation, options);
  }

  /** 独占一条连接执行事务，回滚失败时保留原异常并丢弃不确定的连接。 */
  private executeTransaction<R>(
    ownerId: string,
    operation: (tx: DatabaseTransaction) => Promise<R>,
    options?: MySqlTransactionConfig,
  ): Promise<R> {
    return databaseOperation(async () => {
      const connection = await this.pool.getConnection();
      let failure: { error: unknown } | undefined;
      let discarded = false;
      try {
        const sql = drizzle(connection, { schema, mode: 'default' });
        return await sql.transaction(async (transaction) => {
          const tx = new DatabaseContext(transaction, ownerId);
          try {
            return await operation(tx);
          } catch (error) {
            failure = { error };
            throw error;
          } finally {
            tx.finish();
          }
        }, options);
      } catch (error) {
        // 同一个回调异常表示 Drizzle 已完成回滚；其他异常可能来自 begin/commit/rollback。
        if (!failure || error !== failure.error) {
          connection.destroy();
          discarded = true;
          console.error(JSON.stringify({ event: 'database.transaction.connection_discarded' }));
        }
        throw failure ? failure.error : error;
      } finally {
        if (!discarded) connection.release();
      }
    });
  }

  /**
   * 关闭应用使用的数据库连接池。
   *
   * 应用关闭时释放业务连接，不影响其他服务持有的连接。
   */
  async onApplicationShutdown(): Promise<void> {
    await (this.shutdown ??= this.pool.end());
  }
}
