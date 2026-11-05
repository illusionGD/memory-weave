import * as schema from './schema';
import type { QueryConnection } from './crud-types';
import { defineTable } from './table-repository';
import type { TableExecutor } from './table-repository';

/** 为普通数据库和事务提供相同的具名表入口，保留每张表的字段与访问能力。 */
export class DatabaseTables<C extends QueryConnection> {
  /** 保存本次表操作使用的连接执行器，不持有可变事务状态。 */
  constructor(private readonly executeTable: TableExecutor<C>) {}

  /** 访问 modelConfigurationHeads 表，沿用当前连接、归属和写入能力。 */
  get modelConfigurationHeads() {
    return defineTable(schema.modelConfigurationHeads, {
      scope: 'ownerId',
      access: 'write',
    }).connect(this.executeTable);
  }

  /** 访问 modelConfigurationVersions 表，沿用当前连接、归属和写入能力。 */
  get modelConfigurationVersions() {
    return defineTable(schema.modelConfigurationVersions, {
      scope: 'ownerId',
      access: 'append',
    }).connect(this.executeTable);
  }

  /** 访问 modelCalls 表，沿用当前连接、归属和写入能力。 */
  get modelCalls() {
    return defineTable(schema.modelCalls, { scope: 'ownerId', access: 'write' }).connect(
      this.executeTable,
    );
  }

  /** 访问 modelAttempts 表，沿用当前连接、归属和写入能力。 */
  get modelAttempts() {
    return defineTable(schema.modelAttempts, { scope: 'ownerId', access: 'write' }).connect(
      this.executeTable,
    );
  }

  /** 访问 modelUsageWindows 表，沿用当前连接、归属和写入能力。 */
  get modelUsageWindows() {
    return defineTable(schema.modelUsageWindows, { scope: 'ownerId', access: 'write' }).connect(
      this.executeTable,
    );
  }

  /** 访问 owners 表，沿用当前连接、归属和写入能力。 */
  get owners() {
    return defineTable(schema.owners, { scope: 'id', access: 'write' }).connect(this.executeTable);
  }

  /** 访问 companions 表，沿用当前连接、归属和写入能力。 */
  get companions() {
    return defineTable(schema.companions, { scope: 'ownerId', access: 'write' }).connect(
      this.executeTable,
    );
  }

  /** 访问 personaVersions 表，沿用当前连接、归属和写入能力。 */
  get personaVersions() {
    return defineTable(schema.personaVersions, { scope: 'ownerId', access: 'append' }).connect(
      this.executeTable,
    );
  }

  /** 访问 personaTemplates 表，沿用当前连接、归属和写入能力。 */
  get personaTemplates() {
    return defineTable(schema.personaTemplates, { scope: 'ownerId', access: 'write' }).connect(
      this.executeTable,
    );
  }

  /** 访问 personaTemplateVersions 表，沿用当前连接、归属和写入能力。 */
  get personaTemplateVersions() {
    return defineTable(schema.personaTemplateVersions, {
      scope: 'ownerId',
      access: 'append',
    }).connect(this.executeTable);
  }

  /** 访问 personaFoundations 表，沿用当前连接、归属和写入能力。 */
  get personaFoundations() {
    return defineTable(schema.personaFoundations, { scope: 'ownerId', access: 'write' }).connect(
      this.executeTable,
    );
  }

  /** 访问 conversations 表，沿用当前连接、归属和写入能力。 */
  get conversations() {
    return defineTable(schema.conversations, { scope: 'ownerId', access: 'write' }).connect(
      this.executeTable,
    );
  }

  /** 访问 conversationMembers 表，沿用当前连接、归属和写入能力。 */
  get conversationMembers() {
    return defineTable(schema.conversationMembers, {
      scope: 'ownerId',
      access: 'write',
    }).connect(this.executeTable);
  }

  /** 访问 visibilityGrants 表，沿用当前连接、归属和写入能力。 */
  get visibilityGrants() {
    return defineTable(schema.visibilityGrants, { scope: 'ownerId', access: 'write' }).connect(
      this.executeTable,
    );
  }

  /** 访问 messages 表，沿用当前连接、归属和写入能力。 */
  get messages() {
    return defineTable(schema.messages, { scope: 'ownerId', access: 'write' }).connect(
      this.executeTable,
    );
  }

  /** 访问 messageSources 表，沿用当前连接、归属和写入能力。 */
  get messageSources() {
    return defineTable(schema.messageSources, { scope: 'ownerId', access: 'append' }).connect(
      this.executeTable,
    );
  }

  /** 访问 readReceipts 表，沿用当前连接、归属和写入能力。 */
  get readReceipts() {
    return defineTable(schema.readReceipts, { scope: 'ownerId', access: 'append' }).connect(
      this.executeTable,
    );
  }

  /** 访问 processingRanges 表，沿用当前连接、归属和写入能力。 */
  get processingRanges() {
    return defineTable(schema.processingRanges, { scope: 'ownerId', access: 'write' }).connect(
      this.executeTable,
    );
  }

  /** 访问 receiveBatches 表，沿用当前连接、归属和写入能力。 */
  get receiveBatches() {
    return defineTable(schema.receiveBatches, { scope: 'ownerId', access: 'append' }).connect(
      this.executeTable,
    );
  }

  /** 访问 tasks 表，沿用当前连接、归属和写入能力。 */
  get tasks() {
    return defineTable(schema.tasks, { scope: 'ownerId', access: 'write' }).connect(
      this.executeTable,
    );
  }

  /** 访问 taskConfigurationVersions 表，沿用当前连接、归属和写入能力。 */
  get taskConfigurationVersions() {
    return defineTable(schema.taskConfigurationVersions, {
      scope: 'ownerId',
      access: 'append',
    }).connect(this.executeTable);
  }

  /** 访问 taskAttempts 表，沿用当前连接、归属和写入能力。 */
  get taskAttempts() {
    return defineTable(schema.taskAttempts, { scope: 'ownerId', access: 'write' }).connect(
      this.executeTable,
    );
  }

  /** 访问 taskSchedulerHeads 表，沿用当前连接、归属和写入能力。 */
  get taskSchedulerHeads() {
    return defineTable(schema.taskSchedulerHeads, { scope: 'ownerId', access: 'write' }).connect(
      this.executeTable,
    );
  }

  /** 访问 taskOutbox 表，沿用当前连接、归属和写入能力。 */
  get taskOutbox() {
    return defineTable(schema.taskOutbox, { scope: 'ownerId', access: 'write' }).connect(
      this.executeTable,
    );
  }

  /** 访问 chatThreads 表，沿用当前连接、归属和写入能力。 */
  get chatThreads() {
    return defineTable(schema.chatThreads, { scope: 'ownerId', access: 'write' }).connect(
      this.executeTable,
    );
  }

  /** 访问 chatRuns 表，沿用当前连接、归属和写入能力。 */
  get chatRuns() {
    return defineTable(schema.chatRuns, { scope: 'ownerId', access: 'write' }).connect(
      this.executeTable,
    );
  }

  /** 访问 chatSegments 表，沿用当前连接、归属和写入能力。 */
  get chatSegments() {
    return defineTable(schema.chatSegments, { scope: 'ownerId', access: 'write' }).connect(
      this.executeTable,
    );
  }

  /** 访问 chatDeliveries 表，沿用当前连接、归属和写入能力。 */
  get chatDeliveries() {
    return defineTable(schema.chatDeliveries, { scope: 'ownerId', access: 'write' }).connect(
      this.executeTable,
    );
  }

  /** 访问 lifecycleOperations 表，沿用当前连接、归属和写入能力。 */
  get lifecycleOperations() {
    return defineTable(schema.lifecycleOperations, {
      scope: 'ownerId',
      access: 'write',
    }).connect(this.executeTable);
  }

  /** 访问 lifecycleMessageTargets 表，沿用当前连接、归属和写入能力。 */
  get lifecycleMessageTargets() {
    return defineTable(schema.lifecycleMessageTargets, {
      scope: 'ownerId',
      access: 'append',
    }).connect(this.executeTable);
  }

  /** 访问 chatRunSources 表，沿用当前连接、归属和写入能力。 */
  get chatRunSources() {
    return defineTable(schema.chatRunSources, { scope: 'ownerId', access: 'append' }).connect(
      this.executeTable,
    );
  }

  /** 访问 memoryBatches 表，沿用当前连接、归属和写入能力。 */
  get memoryBatches() {
    return defineTable(schema.memoryBatches, { scope: 'ownerId', access: 'write' }).connect(
      this.executeTable,
    );
  }

  /** 访问 memoryEntries 表，沿用当前连接、归属和写入能力。 */
  get memoryEntries() {
    return defineTable(schema.memoryEntries, { scope: 'ownerId', access: 'write' }).connect(
      this.executeTable,
    );
  }

  /** 访问 memoryVersions 表，沿用当前连接、归属和写入能力。 */
  get memoryVersions() {
    return defineTable(schema.memoryVersions, { scope: 'ownerId', access: 'append' }).connect(
      this.executeTable,
    );
  }

  /** 访问 memoryEvidence 表，沿用当前连接、归属和写入能力。 */
  get memoryEvidence() {
    return defineTable(schema.memoryEvidence, { scope: 'ownerId', access: 'append' }).connect(
      this.executeTable,
    );
  }

  /** 访问 memoryDependencies 表，沿用当前连接、归属和写入能力。 */
  get memoryDependencies() {
    return defineTable(schema.memoryDependencies, {
      scope: 'ownerId',
      access: 'append',
    }).connect(this.executeTable);
  }

  /** 访问 memorySearchDocuments 表，沿用当前连接、归属和写入能力。 */
  get memorySearchDocuments() {
    return defineTable(schema.memorySearchDocuments, {
      scope: 'ownerId',
      access: 'cleanup',
    }).connect(this.executeTable);
  }

  /** 访问 memorySearchTerms 表，沿用当前连接、归属和写入能力。 */
  get memorySearchTerms() {
    return defineTable(schema.memorySearchTerms, { scope: 'ownerId', access: 'cleanup' }).connect(
      this.executeTable,
    );
  }

  /** 访问 memoryVectorIndexes 表，沿用当前连接、归属和写入能力。 */
  get memoryVectorIndexes() {
    return defineTable(schema.memoryVectorIndexes, {
      scope: 'ownerId',
      access: 'write',
    }).connect(this.executeTable);
  }

  /** 访问 chatMemorySources 表，沿用当前连接、归属和写入能力。 */
  get chatMemorySources() {
    return defineTable(schema.chatMemorySources, { scope: 'ownerId', access: 'append' }).connect(
      this.executeTable,
    );
  }

  /** 访问 memoryOriginalSources 表，沿用当前连接、归属和写入能力。 */
  get memoryOriginalSources() {
    return defineTable(schema.memoryOriginalSources, {
      scope: 'ownerId',
      access: 'append',
    }).connect(this.executeTable);
  }

  /** 访问 lifecycleMemoryTargets 表，沿用当前连接、归属和写入能力。 */
  get lifecycleMemoryTargets() {
    return defineTable(schema.lifecycleMemoryTargets, {
      scope: 'ownerId',
      access: 'append',
    }).connect(this.executeTable);
  }
}
