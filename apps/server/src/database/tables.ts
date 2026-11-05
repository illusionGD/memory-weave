import * as schema from './schema';
import type { MySqlTable } from 'drizzle-orm/mysql-core';
import type { QueryConnection, ScopeKey } from './crud-types';
import { defineTable } from './table-repository';
import type { TableAccess, TableExecutor } from './table-repository';

/** 集中声明表能力，普通入口和每个事务各自按需缓存表操作对象。 */
export class DatabaseTables<C extends QueryConnection> {
  private readonly cache = new Map<MySqlTable, unknown>();

  /** 保存当前入口的连接执行器，不持有可变的用户或事务连接。 */
  constructor(private readonly executeTable: TableExecutor<C>) {}

  /** 首次访问时创建表入口，后续访问复用相同对象及字段类型。 */
  private table<T extends MySqlTable, K extends ScopeKey<T>, A extends TableAccess>(
    table: T,
    scope: K,
    access: A,
  ) {
    const create = () => defineTable(table, { scope, access }).connect(this.executeTable);
    if (!this.cache.has(table)) this.cache.set(table, create());
    return this.cache.get(table) as ReturnType<typeof create>;
  }

  /** 访问 modelConfigurationHeads，自动限定当前归属。 */
  get modelConfigurationHeads() {
    return this.table(schema.modelConfigurationHeads, 'ownerId', 'write');
  }

  /** 访问 modelConfigurationVersions，自动限定当前归属。 */
  get modelConfigurationVersions() {
    return this.table(schema.modelConfigurationVersions, 'ownerId', 'append');
  }

  /** 访问 modelCalls，自动限定当前归属。 */
  get modelCalls() {
    return this.table(schema.modelCalls, 'ownerId', 'write');
  }

  /** 访问 modelAttempts，自动限定当前归属。 */
  get modelAttempts() {
    return this.table(schema.modelAttempts, 'ownerId', 'write');
  }

  /** 访问 modelUsageWindows，自动限定当前归属。 */
  get modelUsageWindows() {
    return this.table(schema.modelUsageWindows, 'ownerId', 'write');
  }

  /** 访问 owners，自动限定当前归属。 */
  get owners() {
    return this.table(schema.owners, 'id', 'write');
  }

  /** 访问 companions，自动限定当前归属。 */
  get companions() {
    return this.table(schema.companions, 'ownerId', 'write');
  }

  /** 访问 personaVersions，自动限定当前归属。 */
  get personaVersions() {
    return this.table(schema.personaVersions, 'ownerId', 'append');
  }

  /** 访问 personaTemplates，自动限定当前归属。 */
  get personaTemplates() {
    return this.table(schema.personaTemplates, 'ownerId', 'write');
  }

  /** 访问 personaTemplateVersions，自动限定当前归属。 */
  get personaTemplateVersions() {
    return this.table(schema.personaTemplateVersions, 'ownerId', 'append');
  }

  /** 访问 personaFoundations，自动限定当前归属。 */
  get personaFoundations() {
    return this.table(schema.personaFoundations, 'ownerId', 'write');
  }

  /** 访问 conversations，自动限定当前归属。 */
  get conversations() {
    return this.table(schema.conversations, 'ownerId', 'write');
  }

  /** 访问 conversationMembers，自动限定当前归属。 */
  get conversationMembers() {
    return this.table(schema.conversationMembers, 'ownerId', 'write');
  }

  /** 访问 visibilityGrants，自动限定当前归属。 */
  get visibilityGrants() {
    return this.table(schema.visibilityGrants, 'ownerId', 'write');
  }

  /** 访问 messages，自动限定当前归属。 */
  get messages() {
    return this.table(schema.messages, 'ownerId', 'write');
  }

  /** 访问 messageSources，自动限定当前归属。 */
  get messageSources() {
    return this.table(schema.messageSources, 'ownerId', 'append');
  }

  /** 访问 readReceipts，自动限定当前归属。 */
  get readReceipts() {
    return this.table(schema.readReceipts, 'ownerId', 'append');
  }

  /** 访问 processingRanges，自动限定当前归属。 */
  get processingRanges() {
    return this.table(schema.processingRanges, 'ownerId', 'write');
  }

  /** 访问 receiveBatches，自动限定当前归属。 */
  get receiveBatches() {
    return this.table(schema.receiveBatches, 'ownerId', 'append');
  }

  /** 访问 tasks，自动限定当前归属。 */
  get tasks() {
    return this.table(schema.tasks, 'ownerId', 'write');
  }

  /** 访问 taskConfigurationVersions，自动限定当前归属。 */
  get taskConfigurationVersions() {
    return this.table(schema.taskConfigurationVersions, 'ownerId', 'append');
  }

  /** 访问 taskAttempts，自动限定当前归属。 */
  get taskAttempts() {
    return this.table(schema.taskAttempts, 'ownerId', 'write');
  }

  /** 访问 taskSchedulerHeads，自动限定当前归属。 */
  get taskSchedulerHeads() {
    return this.table(schema.taskSchedulerHeads, 'ownerId', 'write');
  }

  /** 访问 taskOutbox，自动限定当前归属。 */
  get taskOutbox() {
    return this.table(schema.taskOutbox, 'ownerId', 'write');
  }

  /** 访问 chatThreads，自动限定当前归属。 */
  get chatThreads() {
    return this.table(schema.chatThreads, 'ownerId', 'write');
  }

  /** 访问 chatRuns，自动限定当前归属。 */
  get chatRuns() {
    return this.table(schema.chatRuns, 'ownerId', 'write');
  }

  /** 访问 chatDeliveries，自动限定当前归属。 */
  get chatDeliveries() {
    return this.table(schema.chatDeliveries, 'ownerId', 'write');
  }

  /** 访问 lifecycleOperations，自动限定当前归属。 */
  get lifecycleOperations() {
    return this.table(schema.lifecycleOperations, 'ownerId', 'write');
  }

  /** 访问 lifecycleMessageTargets，自动限定当前归属。 */
  get lifecycleMessageTargets() {
    return this.table(schema.lifecycleMessageTargets, 'ownerId', 'append');
  }

  /** 访问 chatRunSources，自动限定当前归属。 */
  get chatRunSources() {
    return this.table(schema.chatRunSources, 'ownerId', 'append');
  }

  /** 访问 memoryBatches，自动限定当前归属。 */
  get memoryBatches() {
    return this.table(schema.memoryBatches, 'ownerId', 'write');
  }

  /** 访问 memoryEntries，自动限定当前归属。 */
  get memoryEntries() {
    return this.table(schema.memoryEntries, 'ownerId', 'write');
  }

  /** 访问 memoryVersions，自动限定当前归属。 */
  get memoryVersions() {
    return this.table(schema.memoryVersions, 'ownerId', 'append');
  }

  /** 访问 memoryEvidence，自动限定当前归属。 */
  get memoryEvidence() {
    return this.table(schema.memoryEvidence, 'ownerId', 'append');
  }

  /** 访问 memoryDependencies，自动限定当前归属。 */
  get memoryDependencies() {
    return this.table(schema.memoryDependencies, 'ownerId', 'append');
  }

  /** 访问 memorySearchDocuments，自动限定当前归属。 */
  get memorySearchDocuments() {
    return this.table(schema.memorySearchDocuments, 'ownerId', 'cleanup');
  }

  /** 访问 memorySearchTerms，自动限定当前归属。 */
  get memorySearchTerms() {
    return this.table(schema.memorySearchTerms, 'ownerId', 'cleanup');
  }

  /** 访问 memoryVectorIndexes，自动限定当前归属。 */
  get memoryVectorIndexes() {
    return this.table(schema.memoryVectorIndexes, 'ownerId', 'write');
  }

  /** 访问 chatMemorySources，自动限定当前归属。 */
  get chatMemorySources() {
    return this.table(schema.chatMemorySources, 'ownerId', 'append');
  }

  /** 访问 memoryOriginalSources，自动限定当前归属。 */
  get memoryOriginalSources() {
    return this.table(schema.memoryOriginalSources, 'ownerId', 'append');
  }

  /** 访问 lifecycleMemoryTargets，自动限定当前归属。 */
  get lifecycleMemoryTargets() {
    return this.table(schema.lifecycleMemoryTargets, 'ownerId', 'append');
  }
}
