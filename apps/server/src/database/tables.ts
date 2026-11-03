import * as schema from './schema';
import { defineTable } from './table-repository';

/** 各表的归属及日常写入能力；历史表仅追加，业务删除仍由生命周期模块负责。 */
export const tables = {
  modelConfigurationHeads: defineTable(schema.modelConfigurationHeads, {
    scope: 'ownerId',
    access: 'write',
  }),
  modelConfigurationVersions: defineTable(schema.modelConfigurationVersions, {
    scope: 'ownerId',
    access: 'append',
  }),
  modelCalls: defineTable(schema.modelCalls, { scope: 'ownerId', access: 'write' }),
  modelAttempts: defineTable(schema.modelAttempts, { scope: 'ownerId', access: 'write' }),
  modelUsageWindows: defineTable(schema.modelUsageWindows, { scope: 'ownerId', access: 'write' }),
  owners: defineTable(schema.owners, { scope: 'id', access: 'write' }),
  companions: defineTable(schema.companions, { scope: 'ownerId', access: 'write' }),
  personaVersions: defineTable(schema.personaVersions, { scope: 'ownerId', access: 'append' }),
  personaTemplates: defineTable(schema.personaTemplates, { scope: 'ownerId', access: 'write' }),
  personaTemplateVersions: defineTable(schema.personaTemplateVersions, {
    scope: 'ownerId',
    access: 'append',
  }),
  personaFoundations: defineTable(schema.personaFoundations, { scope: 'ownerId', access: 'write' }),
  conversations: defineTable(schema.conversations, { scope: 'ownerId', access: 'write' }),
  conversationMembers: defineTable(schema.conversationMembers, {
    scope: 'ownerId',
    access: 'write',
  }),
  visibilityGrants: defineTable(schema.visibilityGrants, { scope: 'ownerId', access: 'write' }),
  messages: defineTable(schema.messages, { scope: 'ownerId', access: 'write' }),
  messageSources: defineTable(schema.messageSources, { scope: 'ownerId', access: 'append' }),
  readReceipts: defineTable(schema.readReceipts, { scope: 'ownerId', access: 'append' }),
  processingRanges: defineTable(schema.processingRanges, { scope: 'ownerId', access: 'write' }),
  receiveBatches: defineTable(schema.receiveBatches, { scope: 'ownerId', access: 'append' }),
  tasks: defineTable(schema.tasks, { scope: 'ownerId', access: 'write' }),
  taskConfigurationVersions: defineTable(schema.taskConfigurationVersions, {
    scope: 'ownerId',
    access: 'append',
  }),
  taskAttempts: defineTable(schema.taskAttempts, { scope: 'ownerId', access: 'write' }),
  taskSchedulerHeads: defineTable(schema.taskSchedulerHeads, { scope: 'ownerId', access: 'write' }),
  taskOutbox: defineTable(schema.taskOutbox, { scope: 'ownerId', access: 'write' }),
  chatThreads: defineTable(schema.chatThreads, { scope: 'ownerId', access: 'write' }),
  chatRuns: defineTable(schema.chatRuns, { scope: 'ownerId', access: 'write' }),
  chatSegments: defineTable(schema.chatSegments, { scope: 'ownerId', access: 'write' }),
  chatDeliveries: defineTable(schema.chatDeliveries, { scope: 'ownerId', access: 'write' }),
  lifecycleOperations: defineTable(schema.lifecycleOperations, {
    scope: 'ownerId',
    access: 'write',
  }),
  lifecycleMessageTargets: defineTable(schema.lifecycleMessageTargets, {
    scope: 'ownerId',
    access: 'append',
  }),
  chatRunSources: defineTable(schema.chatRunSources, { scope: 'ownerId', access: 'append' }),
  memoryBatches: defineTable(schema.memoryBatches, { scope: 'ownerId', access: 'write' }),
  memoryEntries: defineTable(schema.memoryEntries, { scope: 'ownerId', access: 'write' }),
  memoryVersions: defineTable(schema.memoryVersions, { scope: 'ownerId', access: 'append' }),
  memoryEvidence: defineTable(schema.memoryEvidence, { scope: 'ownerId', access: 'append' }),
  memoryDependencies: defineTable(schema.memoryDependencies, {
    scope: 'ownerId',
    access: 'append',
  }),
  memorySearchDocuments: defineTable(schema.memorySearchDocuments, {
    scope: 'ownerId',
    access: 'cleanup',
  }),
  memorySearchTerms: defineTable(schema.memorySearchTerms, { scope: 'ownerId', access: 'cleanup' }),
  memoryVectorIndexes: defineTable(schema.memoryVectorIndexes, {
    scope: 'ownerId',
    access: 'write',
  }),
  chatMemorySources: defineTable(schema.chatMemorySources, { scope: 'ownerId', access: 'append' }),
  memoryOriginalSources: defineTable(schema.memoryOriginalSources, {
    scope: 'ownerId',
    access: 'append',
  }),
  lifecycleMemoryTargets: defineTable(schema.lifecycleMemoryTargets, {
    scope: 'ownerId',
    access: 'append',
  }),
};
