import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { SERVER_CONFIG } from '../config';
import type { RuntimeConfig } from '../config';
import { querySchemaStatus } from './migrations';
import * as schema from './schema';

/** 领域服务共享的类型化数据库入口。 */
export type Database = NodePgDatabase<typeof schema>;

/** 事务回调使用同一连接，适用于发布序号与幂等结果的原子提交。 */
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** 为业务提供当前部署归属、结构状态和脱敏后的数据库错误。 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;
  readonly db: Database;

  constructor(@Inject(SERVER_CONFIG) config: RuntimeConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 4,
      connectionTimeoutMillis: 1000,
      idleTimeoutMillis: 10_000,
      statement_timeout: 5000,
    });
    // 空闲连接断开不终止 HTTP 进程，下一次操作重新判断数据库可用性。
    this.pool.on('error', () => undefined);
    this.db = drizzle(this.pool, { schema });
  }

  /** 只读检查当前迁移与数据库历史是否一致，不在健康检查中执行 DDL。 */
  async getSchemaStatus(): Promise<{
    status: 'ready' | 'pending' | 'unavailable';
    version: string | null;
  }> {
    return querySchemaStatus(this.pool);
  }

  /**
   * 从持久配置取得部署管理者，再执行带归属限制的领域操作。
   * @param operation 领域服务必须在所有查询及写入中限定 ownerId。
   * @returns 已完成的领域操作结果；不向 HTTP 返回驱动异常与连接信息。
   */
  async withOwner<T>(operation: (ownerId: string, db: Database) => Promise<T>): Promise<T> {
    try {
      const status = await this.getSchemaStatus();
      if (status.status !== 'ready') {
        throw new ServiceUnavailableException('数据服务或数据库结构尚未就绪。');
      }
      const [owner] = await this.db
        .select({ id: schema.owners.id })
        .from(schema.owners)
        .where(eq(schema.owners.deploymentKey, 'local'))
        .limit(1);
      if (!owner) throw new ServiceUnavailableException('部署身份尚未就绪。');
      return await operation(owner.id, this.db);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const code = databaseErrorCode(error);
      if (code === '23505') throw new ConflictException('命令与已有数据冲突。');
      if (['23503', '23514', '23502', '22P02'].includes(code ?? '')) {
        throw new BadRequestException('关联数据或字段不符合约束。');
      }
      throw new ServiceUnavailableException('数据服务或数据库结构尚未就绪。');
    }
  }

  /** 应用关闭时释放业务连接，不影响其他服务持有的连接。 */
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

/** Drizzle 会把驱动异常放在 cause 中，只提取受控分类所需的错误代码。 */
function databaseErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object') return undefined;
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}
