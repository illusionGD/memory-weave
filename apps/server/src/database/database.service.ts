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
import { TableRepository } from './table-repository';
import type { TableAccess } from './table-repository';
import type { MySqlTable } from 'drizzle-orm/mysql-core';
import type { MySqlTransactionConfig } from 'drizzle-orm/mysql-core';
import { ApiException, databaseOperation } from '../http/api-exception';

/** 原始 Drizzle 查询连接，供基础实现和显式 SQL 使用。 */
export type Database = MySql2Database<typeof schema>;

/** 事务回调使用同一连接，适用于发布序号与幂等结果的原子提交。 */
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** 业务查询接受普通连接或当前事务。 */
export type QueryDatabase = Database | DatabaseTransaction;

/** 为业务提供当前部署归属、结构状态和脱敏后的数据库错误。 */
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly pool: Pool;
  readonly sql: Database;
  private shutdown: Promise<void> | undefined;
  private readonly transactions = new WeakSet<DatabaseTransaction>();
  readonly modelConfigurationHeads;
  readonly modelConfigurationVersions;
  readonly modelCalls;
  readonly modelAttempts;
  readonly modelUsageWindows;
  readonly owners;
  readonly companions;
  readonly personaVersions;
  readonly personaTemplates;
  readonly personaTemplateVersions;
  readonly personaFoundations;
  readonly conversations;
  readonly conversationMembers;
  readonly visibilityGrants;
  readonly messages;
  readonly messageSources;
  readonly readReceipts;
  readonly processingRanges;
  readonly receiveBatches;
  readonly tasks;
  readonly taskConfigurationVersions;
  readonly taskAttempts;
  readonly taskSchedulerHeads;
  readonly taskOutbox;
  readonly chatThreads;
  readonly chatRuns;
  readonly chatDeliveries;
  readonly lifecycleOperations;
  readonly lifecycleMessageTargets;
  readonly chatRunSources;
  readonly memoryBatches;
  readonly memoryEntries;
  readonly memoryVersions;
  readonly memoryEvidence;
  readonly memoryDependencies;
  readonly memorySearchDocuments;
  readonly memorySearchTerms;
  readonly memoryVectorIndexes;
  readonly chatMemorySources;
  readonly memoryOriginalSources;
  readonly lifecycleMemoryTargets;

  /** 初始化数据库连接与查询服务。 */
  constructor(@Inject(SERVER_CONFIG) config: RuntimeConfig) {
    this.pool = createPool({
      ...mysqlConnectionOptions(config.databaseUrl),
      connectionLimit: 4,
      maxIdle: 4,
      idleTimeout: 10_000,
      queueLimit: 32,
    });
    this.sql = drizzle(this.pool, { schema, mode: 'default' });
    /** 创建可复用的表入口，归属在每次操作时显式传入。 */
    const repository = <T extends MySqlTable>(table: T, access: TableAccess = 'write') =>
      new TableRepository(table, 'ownerId', this.sql, access, this.transactions);
    this.modelConfigurationHeads = repository(schema.modelConfigurationHeads);
    this.modelConfigurationVersions = repository(schema.modelConfigurationVersions, 'append');
    this.modelCalls = repository(schema.modelCalls);
    this.modelAttempts = repository(schema.modelAttempts);
    this.modelUsageWindows = repository(schema.modelUsageWindows);
    this.owners = new TableRepository(schema.owners, 'id', this.sql, 'write', this.transactions);
    this.companions = repository(schema.companions);
    this.personaVersions = repository(schema.personaVersions, 'append');
    this.personaTemplates = repository(schema.personaTemplates);
    this.personaTemplateVersions = repository(schema.personaTemplateVersions, 'append');
    this.personaFoundations = repository(schema.personaFoundations);
    this.conversations = repository(schema.conversations);
    this.conversationMembers = repository(schema.conversationMembers);
    this.visibilityGrants = repository(schema.visibilityGrants);
    this.messages = repository(schema.messages);
    this.messageSources = repository(schema.messageSources, 'append');
    this.readReceipts = repository(schema.readReceipts, 'append');
    this.processingRanges = repository(schema.processingRanges);
    this.receiveBatches = repository(schema.receiveBatches, 'append');
    this.tasks = repository(schema.tasks);
    this.taskConfigurationVersions = repository(schema.taskConfigurationVersions, 'append');
    this.taskAttempts = repository(schema.taskAttempts);
    this.taskSchedulerHeads = repository(schema.taskSchedulerHeads);
    this.taskOutbox = repository(schema.taskOutbox);
    this.chatThreads = repository(schema.chatThreads);
    this.chatRuns = repository(schema.chatRuns);
    this.chatDeliveries = repository(schema.chatDeliveries);
    this.lifecycleOperations = repository(schema.lifecycleOperations);
    this.lifecycleMessageTargets = repository(schema.lifecycleMessageTargets, 'append');
    this.chatRunSources = repository(schema.chatRunSources, 'append');
    this.memoryBatches = repository(schema.memoryBatches);
    this.memoryEntries = repository(schema.memoryEntries);
    this.memoryVersions = repository(schema.memoryVersions, 'append');
    this.memoryEvidence = repository(schema.memoryEvidence, 'append');
    this.memoryDependencies = repository(schema.memoryDependencies, 'append');
    this.memorySearchDocuments = repository(schema.memorySearchDocuments, 'cleanup');
    this.memorySearchTerms = repository(schema.memorySearchTerms, 'cleanup');
    this.memoryVectorIndexes = repository(schema.memoryVectorIndexes);
    this.chatMemorySources = repository(schema.chatMemorySources, 'append');
    this.memoryOriginalSources = repository(schema.memoryOriginalSources, 'append');
    this.lifecycleMemoryTargets = repository(schema.lifecycleMemoryTargets, 'append');
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

  /** 在独立连接执行事务，回调返回则提交，抛出异常则回滚。 */
  transaction<R>(
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
          this.transactions.add(transaction);
          try {
            return await operation(transaction);
          } catch (error) {
            failure = { error };
            throw error;
          } finally {
            this.transactions.delete(transaction);
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
