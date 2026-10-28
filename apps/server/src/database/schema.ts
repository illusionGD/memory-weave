import type { TaskInput, MessageOutboxInput } from '../modules/tasks/task-types';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  check,
  bigint,
  foreignKey,
  index,
  int,
  json,
  mysqlTable,
  text,
  datetime,
  varchar,
  customType,
  unique,
} from 'drizzle-orm/mysql-core';
import type { MySqlTableExtraConfigValue } from 'drizzle-orm/mysql-core';
import type {
  Task,
  TaskKind,
  TaskStatus,
  TaskScope,
  TaskConfiguration,
  ModelConfiguration,
  ModelTaskRole,
  ModelOperation,
  ModelCallStatus,
  ModelResult,
  ModelCallContext,
  PersonaDocument,
} from '@memory-weave/contracts';

/** 创建时保留的初始设定，与后续当前人格版本分开存储。 */
export interface InitialSnapshot {
  id: string;
  schemaVersion: 1;
  profileText: string;
  sourceKind: 'initial_setting';
  createdAt: string;
}

/** 一次接收取得的确切原文版本，重试时不能重新选择消息。 */
export interface ReceivedMessageVersion {
  messageId: string;
  contentVersion: number;
}

/** UUID 统一为小写；ASCII 不区分大小写索引保持既有 UUID 查询语义。 */
const uuid = customType<{ data: string; driverData: string }>({
  dataType: () => 'char(36) character set ascii collate ascii_general_ci',
  toDriver: (value) => value.toLowerCase(),
  fromDriver: (value) => value.toLowerCase(),
});
const createdAt = () =>
  datetime('created_at', { fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`);

/** 模型配置的当前指针；行锁同时串行化配置切换与预算预留。 */
export const modelConfigurationHeads = mysqlTable('model_configuration_heads', {
  ownerId: uuid('owner_id')
    .primaryKey()
    .references(() => owners.id),
  activeVersion: int('active_version').notNull().default(0),
});

/** 配置只追加不可变版本；回滚也创建新版本，不覆盖历史。 */
export const modelConfigurationVersions = mysqlTable(
  'model_configuration_versions',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id),
    version: int('version').notNull(),
    source: varchar('source', { length: 24 }).$type<'default' | 'deployment'>().notNull(),
    config: json('config').$type<ModelConfiguration>().notNull(),
    evaluationNote: varchar('evaluation_note', { length: 500 }).notNull(),
    requestId: uuid('request_id').notNull(),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    createdAt: createdAt(),
  },
  (table): MySqlTableExtraConfigValue[] => [
    unique('model_config_owner_version').on(table.ownerId, table.version),
    unique('model_config_owner_request').on(table.ownerId, table.requestId),
    unique('model_config_owner_id').on(table.ownerId, table.id),
    check('model_config_version_positive', sql`${table.version} > 0`),
  ],
);

/** 逻辑模型调用，保存已校验结果与诊断，不保存原始输入或外部错误。 */
export const modelCalls = mysqlTable(
  'model_calls',
  {
    context: json('context').$type<ModelCallContext>().notNull(),
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id),
    requestId: uuid('request_id').notNull(),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    configId: uuid('config_id').notNull(),
    configVersion: int('config_version').notNull(),
    role: varchar('role', { length: 32 }).$type<ModelTaskRole>().notNull(),
    operation: varchar('operation', { length: 20 }).$type<ModelOperation>().notNull(),
    lane: varchar('lane', { length: 20 }).$type<'interactive' | 'background'>().notNull(),
    providerId: varchar('provider_id', { length: 48 }).notNull(),
    model: varchar('model', { length: 120 }).notNull(),
    status: varchar('status', { length: 20 }).$type<ModelCallStatus>().notNull(),
    errorCode: int('error_code'),
    result: json('result').$type<ModelResult>(),
    createdAt: createdAt(),
    finishedAt: datetime('finished_at', { fsp: 3 }),
  },
  (table): MySqlTableExtraConfigValue[] => [
    unique('model_call_owner_request').on(table.ownerId, table.requestId),
    unique('model_call_owner_id').on(table.ownerId, table.id),
    index('model_call_owner_status').on(table.ownerId, table.status),
    foreignKey({
      name: 'model_call_config_fk',
      columns: [table.ownerId, table.configId],
      foreignColumns: [modelConfigurationVersions.ownerId, modelConfigurationVersions.id],
    }),
  ],
);

/** 每次实际请求的预留与结算；超时、取消和失败不删除计量。 */
export const modelAttempts = mysqlTable(
  'model_attempts',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id').notNull(),
    callId: uuid('call_id').notNull(),
    number: int('number').notNull(),
    role: varchar('role', { length: 32 }).$type<ModelTaskRole>().notNull(),
    lane: varchar('lane', { length: 20 }).$type<'interactive' | 'background'>().notNull(),
    day: varchar('day', { length: 10 }).notNull(),
    status: varchar('status', { length: 20 }).$type<ModelCallStatus>().notNull(),
    usageSource: varchar('usage_source', { length: 20 }).$type<'reported' | 'reserved'>().notNull(),
    inputTokens: int('input_tokens'),
    outputTokens: int('output_tokens'),
    chargedTokens: bigint('charged_tokens', { mode: 'number' }).notNull(),
    chargedCostMicros: bigint('charged_cost_micros', { mode: 'number' }).notNull(),
    errorCode: int('error_code'),
    actualModel: varchar('actual_model', { length: 160 }),
    responseFingerprint: varchar('response_fingerprint', { length: 64 }),
    startedAt: datetime('started_at', { fsp: 3 }).notNull(),
    deadlineAt: datetime('deadline_at', { fsp: 3 }).notNull(),
    finishedAt: datetime('finished_at', { fsp: 3 }),
  },
  (table): MySqlTableExtraConfigValue[] => [
    unique('model_attempt_call_number').on(table.ownerId, table.callId, table.number),
    index('model_attempt_running_deadline').on(table.ownerId, table.status, table.deadlineAt),
    foreignKey({
      name: 'model_attempt_call_fk',
      columns: [table.ownerId, table.callId],
      foreignColumns: [modelCalls.ownerId, modelCalls.id],
    }),
    check(
      'model_attempt_charge_nonnegative',
      sql`${table.chargedTokens} >= 0 AND ${table.chargedCostMicros} >= 0 AND ${table.number} > 0`,
    ),
  ],
);

/** 固定 UTC 日统计，global 与任务分别累计；不会随配置版本重建。 */
export const modelUsageWindows = mysqlTable(
  'model_usage_windows',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id),
    day: varchar('day', { length: 10 }).notNull(),
    scope: varchar('scope', { length: 32 }).notNull(),
    requests: bigint('requests', { mode: 'number' }).notNull().default(0),
    tokens: bigint('tokens', { mode: 'number' }).notNull().default(0),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
  },
  (table): MySqlTableExtraConfigValue[] => [
    unique('model_usage_owner_day_scope').on(table.ownerId, table.day, table.scope),
    check(
      'model_usage_nonnegative',
      sql`${table.requests} >= 0 AND ${table.tokens} >= 0 AND ${table.costMicros} >= 0`,
    ),
  ],
);

/** 当前部署唯一的管理者；迁移生成身份，请求不能指定部署身份。 */
export const owners = mysqlTable(
  'owners',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    deploymentKey: varchar('deployment_key', { length: 32 }).notNull().unique().default('local'),
    /** 供界面展示的当前名称；改名不改变身份或覆盖历史发言。 */
    displayName: varchar('display_name', { length: 80 }).notNull().default('用户'),
    createdAt: createdAt(),
  },
  (table): MySqlTableExtraConfigValue[] => [
    check(
      'owners_display_name_length',
      sql`char_length(trim(${table.displayName})) BETWEEN 1 AND 80`,
    ),
  ],
);

/** 稳定实例及其当前运行代次；共同会话原文不级联归属于实例。 */
export const companions = mysqlTable(
  'companions',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id),
    name: varchar('name', { length: 80 }).notNull(),
    runtimeEpoch: int('runtime_epoch').notNull().default(1),
    version: int('version').notNull().default(1),
    initialSnapshot: json('initial_snapshot').$type<InitialSnapshot>().notNull(),
    currentPersonaVersionId: uuid('current_persona_version_id'),
    requestId: uuid('request_id').notNull(),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    createdAt: createdAt(),
  },
  (table): MySqlTableExtraConfigValue[] => [
    unique('companions_owner_id_unique').on(table.ownerId, table.id),
    unique('companions_request_unique').on(table.ownerId, table.requestId),
    check('companions_versions_positive', sql`${table.runtimeEpoch} > 0 AND ${table.version} > 0`),
    check('companions_name_length', sql`char_length(${table.name}) BETWEEN 1 AND 80`),
    foreignKey({
      name: 'companions_current_persona_fk',
      columns: [table.ownerId, table.id, table.currentPersonaVersionId],
      foreignColumns: [personaVersions.ownerId, personaVersions.companionId, personaVersions.id],
    }),
  ],
);

/** 人格版本与初始快照分别保存，版本只能属于对应实例及管理者。 */
export const personaVersions = mysqlTable(
  'persona_versions',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id').notNull(),
    companionId: uuid('companion_id').notNull(),
    runtimeEpoch: int('runtime_epoch').notNull(),
    version: int('version').notNull(),
    profileText: text('profile_text').notNull(),
    document: json('document').$type<PersonaDocument>(),
    origin: varchar('origin', { length: 24 })
      .$type<'initial_text' | 'initialization' | 'lock_revision'>()
      .notNull()
      .default('initial_text'),
    parentVersionId: uuid('parent_version_id'),
    modelCallId: uuid('model_call_id'),
    mode: varchar('mode', { length: 12 }).$type<'test' | 'model'>(),
    commandId: uuid('command_id'),
    commandFingerprint: varchar('command_fingerprint', { length: 64 }),
    createdAt: createdAt(),
  },
  (table): MySqlTableExtraConfigValue[] => [
    unique('persona_versions_owner_companion_id_unique').on(
      table.ownerId,
      table.companionId,
      table.id,
    ),
    unique('persona_versions_number_unique').on(
      table.ownerId,
      table.companionId,
      table.runtimeEpoch,
      table.version,
    ),
    unique('persona_versions_command').on(table.ownerId, table.companionId, table.commandId),
    foreignKey({
      name: 'persona_versions_parent',
      columns: [table.ownerId, table.companionId, table.parentVersionId],
      foreignColumns: [table.ownerId, table.companionId, table.id],
    }),
    foreignKey({
      name: 'persona_versions_model_call',
      columns: [table.ownerId, table.modelCallId],
      foreignColumns: [modelCalls.ownerId, modelCalls.id],
    }),
    foreignKey({
      name: 'persona_versions_ref_1',
      columns: [table.ownerId, table.companionId],
      foreignColumns: [companions.ownerId, companions.id],
    }),
    check('persona_versions_positive', sql`${table.runtimeEpoch} > 0 AND ${table.version} > 0`),
    check(
      'persona_versions_profile_length',
      sql`char_length(${table.profileText}) BETWEEN 1 AND 4000`,
    ),
  ],
);

/** 模板身份与当前版本指针，不存放实例成长或私密经历。 */
export const personaTemplates = mysqlTable(
  'persona_templates',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id),
    version: int('version').notNull(),
    requestId: uuid('request_id').notNull(),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
  },
  (table) => [
    unique('persona_templates_owner_id').on(table.ownerId, table.id),
    unique('persona_templates_request').on(table.ownerId, table.requestId),
    check('persona_templates_version_positive', sql`${table.version} > 0`),
  ],
);

/** 模板只追加版本；伴侣创建时固定确切版本及内容。 */
export const personaTemplateVersions = mysqlTable(
  'persona_template_versions',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id').notNull(),
    templateId: uuid('template_id').notNull(),
    version: int('version').notNull(),
    name: varchar('name', { length: 80 }).notNull(),
    initialProfile: text('initial_profile').notNull(),
    lockedFeatures: json('locked_features').$type<string[]>().notNull(),
    requestId: uuid('request_id').notNull(),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('template_versions_number').on(table.ownerId, table.templateId, table.version),
    unique('template_versions_request').on(table.ownerId, table.templateId, table.requestId),
    foreignKey({
      name: 'template_versions_parent',
      columns: [table.ownerId, table.templateId],
      foreignColumns: [personaTemplates.ownerId, personaTemplates.id],
    }),
    check('template_versions_positive', sql`${table.version} > 0`),
  ],
);

/** 初始整理的固定来源和首个采用版本，不随着当前人格更新。 */
export const personaFoundations = mysqlTable(
  'persona_foundations',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id').notNull(),
    companionId: uuid('companion_id').notNull(),
    runtimeEpoch: int('runtime_epoch').notNull(),
    requestId: uuid('request_id').notNull(),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    nameOverride: varchar('name_override', { length: 80 }),
    template: json('template').$type<{ id: string; version: number }>(),
    explicitLocks: json('explicit_locks').$type<string[]>().notNull(),
    taskId: uuid('task_id').notNull(),
    initialPersonaVersionId: uuid('initial_persona_version_id'),
    createdAt: createdAt(),
  },
  (table) => [
    unique('persona_foundations_scope').on(table.ownerId, table.companionId, table.runtimeEpoch),
    unique('persona_foundations_request').on(table.ownerId, table.requestId),
    foreignKey({
      name: 'persona_foundations_companion',
      columns: [table.ownerId, table.companionId],
      foreignColumns: [companions.ownerId, companions.id],
    }),
    foreignKey({
      name: 'persona_foundations_initial',
      columns: [table.ownerId, table.companionId, table.initialPersonaVersionId],
      foreignColumns: [personaVersions.ownerId, personaVersions.companionId, personaVersions.id],
    }),
  ],
);

/** 会话保存共享顺序；发布命令在事务中锁定该行后分配序号。 */
export const conversations = mysqlTable(
  'conversations',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id),
    kind: varchar('kind', { length: 32, enum: ['private', 'group'] }).notNull(),
    title: varchar('title', { length: 80 }).notNull(),
    version: int('version').notNull().default(1),
    lastSequence: int('last_sequence').notNull().default(0),
    requestId: uuid('request_id').notNull(),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('conversations_owner_id_unique').on(table.ownerId, table.id),
    unique('conversations_request_unique').on(table.ownerId, table.requestId),
    check('conversations_kind_valid', sql`${table.kind} IN ('private', 'group')`),
    check(
      'conversations_versions_positive',
      sql`${table.version} > 0 AND ${table.lastSequence} >= 0`,
    ),
    check('conversations_title_length', sql`char_length(${table.title}) BETWEEN 1 AND 80`),
  ],
);

/** 成员身份绑定加入时的实例代次，与历史授权独立。 */
export const conversationMembers = mysqlTable(
  'conversation_members',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    kind: varchar('kind', { length: 32, enum: ['user', 'companion'] }).notNull(),
    userId: uuid('user_id'),
    companionId: uuid('companion_id'),
    runtimeEpoch: int('runtime_epoch'),
    joinedSequence: int('joined_sequence').notNull().default(1),
    leftSequence: int('left_sequence'),
    permissionVersion: int('permission_version').notNull().default(1),
  },
  (table) => [
    unique('conversation_members_owner_id_unique').on(table.ownerId, table.id),
    unique('conversation_members_conversation_id_unique').on(
      table.ownerId,
      table.conversationId,
      table.id,
    ),
    unique('conversation_members_user_unique').on(
      table.ownerId,
      table.conversationId,
      table.userId,
    ),
    unique('conversation_members_companion_unique').on(
      table.ownerId,
      table.conversationId,
      table.companionId,
      table.runtimeEpoch,
    ),
    foreignKey({
      name: 'conversation_members_ref_1',
      columns: [table.ownerId, table.conversationId],
      foreignColumns: [conversations.ownerId, conversations.id],
    }),
    foreignKey({
      name: 'conversation_members_ref_2',
      columns: [table.ownerId, table.companionId],
      foreignColumns: [companions.ownerId, companions.id],
    }),
    check(
      'conversation_members_identity_valid',
      sql`(${table.kind} = 'user' AND ${table.userId} = ${table.ownerId} AND ${table.userId} IS NOT NULL AND ${table.companionId} IS NULL AND ${table.runtimeEpoch} IS NULL) OR (${table.kind} = 'companion' AND ${table.userId} IS NULL AND ${table.companionId} IS NOT NULL AND ${table.runtimeEpoch} IS NOT NULL AND ${table.runtimeEpoch} > 0)`,
    ),
    check(
      'conversation_members_range_valid',
      sql`${table.joinedSequence} > 0 AND (${table.leftSequence} IS NULL OR ${table.leftSequence} >= ${table.joinedSequence}) AND ${table.permissionVersion} > 0`,
    ),
  ],
);

/** 序号授权表达成员期间与历史权限，避免将身份等同于全部历史可见。 */
export const visibilityGrants = mysqlTable(
  'visibility_grants',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    startSequence: int('start_sequence').notNull(),
    endSequence: int('end_sequence'),
    kind: varchar('kind', { length: 32, enum: ['membership', 'history'] }).notNull(),
    permissionVersion: int('permission_version').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'visibility_grants_ref_1',
      columns: [table.ownerId, table.membershipId],
      foreignColumns: [conversationMembers.ownerId, conversationMembers.id],
    }),
    unique('visibility_grants_range_unique').on(
      table.ownerId,
      table.membershipId,
      table.kind,
      table.startSequence,
      table.permissionVersion,
    ),
    check('visibility_grants_kind_valid', sql`${table.kind} IN ('membership', 'history')`),
    check(
      'visibility_grants_range_valid',
      sql`${table.startSequence} > 0 AND (${table.endSequence} IS NULL OR ${table.endSequence} >= ${table.startSequence}) AND ${table.permissionVersion} > 0`,
    ),
  ],
);

/** 原文单份保存；草稿保存、发布、实际取得和后续整理分别记录。 */
export const messages = mysqlTable(
  'messages',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    speakerMembershipId: uuid('speaker_membership_id').notNull(),
    schemaVersion: int('schema_version').notNull().default(1),
    contentVersion: int('content_version').notNull().default(1),
    revision: int('revision').notNull().default(1),
    text: text('text').notNull(),
    state: varchar('state', { length: 32, enum: ['draft', 'published'] })
      .notNull()
      .default('draft'),
    sequence: int('sequence'),
    occurredAt: datetime('occurred_at', { fsp: 3 }),
    receivedAt: datetime('received_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    publishedAt: datetime('published_at', { fsp: 3 }),
    validFrom: datetime('valid_from', { fsp: 3 }),
    validUntil: datetime('valid_until', { fsp: 3 }),
    epistemicKind: varchar('epistemic_kind', {
      length: 32,
      enum: ['statement', 'report', 'inference', 'setting'],
    })
      .notNull()
      .default('statement'),
    reality: varchar('reality', { length: 32, enum: ['unspecified', 'real', 'fictional'] })
      .notNull()
      .default('unspecified'),
    sourceKind: varchar('source_kind', {
      length: 32,
      enum: ['user_input', 'admin_companion_input'],
    }).notNull(),
    replyToMessageId: uuid('reply_to_message_id'),
    requestId: uuid('request_id').notNull(),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    publishRequestId: uuid('publish_request_id'),
    publishFingerprint: varchar('publish_fingerprint', { length: 64 }),
  },
  (table): MySqlTableExtraConfigValue[] => [
    unique('messages_owner_id_unique').on(table.ownerId, table.id),
    unique('messages_conversation_id_unique').on(table.ownerId, table.conversationId, table.id),
    unique('messages_content_version_unique').on(table.ownerId, table.id, table.contentVersion),
    unique('messages_conversation_content_unique').on(
      table.ownerId,
      table.conversationId,
      table.id,
      table.contentVersion,
    ),
    unique('messages_sequence_unique').on(table.ownerId, table.conversationId, table.sequence),
    unique('messages_request_unique').on(table.ownerId, table.conversationId, table.requestId),
    unique('messages_publish_request_unique').on(
      table.ownerId,
      table.conversationId,
      table.publishRequestId,
    ),
    foreignKey({
      name: 'messages_ref_1',
      columns: [table.ownerId, table.conversationId],
      foreignColumns: [conversations.ownerId, conversations.id],
    }),
    foreignKey({
      name: 'messages_ref_2',
      columns: [table.ownerId, table.conversationId, table.speakerMembershipId],
      foreignColumns: [
        conversationMembers.ownerId,
        conversationMembers.conversationId,
        conversationMembers.id,
      ],
    }),
    foreignKey({
      name: 'messages_ref_3',
      columns: [table.ownerId, table.conversationId, table.replyToMessageId],
      foreignColumns: [table.ownerId, table.conversationId, table.id],
    }),
    check(
      'messages_versions_positive',
      sql`${table.schemaVersion} > 0 AND ${table.contentVersion} > 0 AND ${table.revision} > 0`,
    ),
    check('messages_text_length', sql`char_length(${table.text}) BETWEEN 1 AND 4000`),
    check(
      'messages_publication_valid',
      sql`(${table.state} = 'draft' AND ${table.sequence} IS NULL AND ${table.publishedAt} IS NULL AND ${table.publishRequestId} IS NULL AND ${table.publishFingerprint} IS NULL) OR (${table.state} = 'published' AND ${table.sequence} IS NOT NULL AND ${table.sequence} > 0 AND ${table.publishedAt} IS NOT NULL AND ${table.publishRequestId} IS NOT NULL AND ${table.publishFingerprint} IS NOT NULL)`,
    ),
    check(
      'messages_validity_ordered',
      sql`${table.validFrom} IS NULL OR ${table.validUntil} IS NULL OR ${table.validUntil} >= ${table.validFrom}`,
    ),
    check(
      'messages_epistemic_kind_valid',
      sql`${table.epistemicKind} IN ('statement', 'report', 'inference', 'setting')`,
    ),
    check('messages_reality_valid', sql`${table.reality} IN ('unspecified', 'real', 'fictional')`),
    check(
      'messages_source_kind_valid',
      sql`${table.sourceKind} IN ('user_input', 'admin_companion_input')`,
    ),
  ],
);

/** 引用保留稳定原文和版本；服务层额外校验发言者的会话可见范围。 */
export const messageSources = mysqlTable(
  'message_sources',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id').notNull(),
    messageId: uuid('message_id').notNull(),
    sourceMessageId: uuid('source_message_id').notNull(),
    sourceContentVersion: int('source_content_version').notNull(),
    relation: varchar('relation', { length: 32, enum: ['reference', 'report'] }).notNull(),
  },
  (table) => [
    unique('message_sources_reference_unique').on(
      table.ownerId,
      table.messageId,
      table.sourceMessageId,
      table.sourceContentVersion,
      table.relation,
    ),
    foreignKey({
      name: 'message_sources_ref_1',
      columns: [table.ownerId, table.messageId],
      foreignColumns: [messages.ownerId, messages.id],
    }),
    foreignKey({
      name: 'message_sources_ref_2',
      columns: [table.ownerId, table.sourceMessageId, table.sourceContentVersion],
      foreignColumns: [messages.ownerId, messages.id, messages.contentVersion],
    }),
    check('message_sources_relation_valid', sql`${table.relation} IN ('reference', 'report')`),
    check('message_sources_not_self', sql`${table.messageId} <> ${table.sourceMessageId}`),
  ],
);

/** 每个实例实际取得的正文范围；查询与发布不会写入此表。 */
export const readReceipts = mysqlTable(
  'read_receipts',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id').notNull(),
    companionId: uuid('companion_id').notNull(),
    runtimeEpoch: int('runtime_epoch').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    messageId: uuid('message_id').notNull(),
    contentVersion: int('content_version').notNull(),
    acquiredAt: datetime('acquired_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    startOffset: int('start_offset').notNull(),
    endOffset: int('end_offset').notNull(),
  },
  (table) => [
    unique('read_receipts_instance_message_unique').on(
      table.ownerId,
      table.companionId,
      table.runtimeEpoch,
      table.messageId,
      table.contentVersion,
    ),
    foreignKey({
      name: 'read_receipts_ref_1',
      columns: [table.ownerId, table.companionId],
      foreignColumns: [companions.ownerId, companions.id],
    }),
    foreignKey({
      name: 'read_receipts_ref_2',
      columns: [table.ownerId, table.conversationId, table.messageId, table.contentVersion],
      foreignColumns: [
        messages.ownerId,
        messages.conversationId,
        messages.id,
        messages.contentVersion,
      ],
    }),
    check(
      'read_receipts_range_valid',
      sql`${table.runtimeEpoch} > 0 AND ${table.startOffset} >= 0 AND ${table.endOffset} >= ${table.startOffset}`,
    ),
  ],
);

/** 每份原文独立登记待整理区间，不能由最大游标跳过未处理空洞。 */
export const processingRanges = mysqlTable(
  'processing_ranges',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id').notNull(),
    companionId: uuid('companion_id').notNull(),
    runtimeEpoch: int('runtime_epoch').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    messageId: uuid('message_id').notNull(),
    contentVersion: int('content_version').notNull(),
    startSequence: int('start_sequence').notNull(),
    endSequence: int('end_sequence').notNull(),
    stage: varchar('stage', { length: 32, enum: ['memory_extraction'] })
      .notNull()
      .default('memory_extraction'),
    status: varchar('status', { length: 32, enum: ['pending'] })
      .notNull()
      .default('pending'),
    createdAt: createdAt(),
  },
  (table) => [
    unique('processing_ranges_instance_message_unique').on(
      table.ownerId,
      table.companionId,
      table.runtimeEpoch,
      table.messageId,
      table.contentVersion,
      table.stage,
    ),
    index('processing_ranges_conversation_sequence_idx').on(
      table.ownerId,
      table.companionId,
      table.runtimeEpoch,
      table.conversationId,
      table.startSequence,
    ),
    foreignKey({
      name: 'processing_ranges_ref_1',
      columns: [table.ownerId, table.companionId],
      foreignColumns: [companions.ownerId, companions.id],
    }),
    foreignKey({
      name: 'processing_ranges_ref_2',
      columns: [table.ownerId, table.conversationId, table.messageId, table.contentVersion],
      foreignColumns: [
        messages.ownerId,
        messages.conversationId,
        messages.id,
        messages.contentVersion,
      ],
    }),
    check(
      'processing_ranges_range_valid',
      sql`${table.runtimeEpoch} > 0 AND ${table.startSequence} > 0 AND ${table.endSequence} >= ${table.startSequence}`,
    ),
    check(
      'processing_ranges_stage_valid',
      sql`${table.stage} = 'memory_extraction' AND ${table.status} = 'pending'`,
    ),
  ],
);

/** 接收命令的稳定结果，重试复用确切消息集合和首次取得时间。 */
export const receiveBatches = mysqlTable(
  'receive_batches',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id').notNull(),
    companionId: uuid('companion_id').notNull(),
    runtimeEpoch: int('runtime_epoch').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    requestId: uuid('request_id').notNull(),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    messages: json('messages').$type<ReceivedMessageVersion[]>().notNull(),
    acquiredAt: datetime('acquired_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    unique('receive_batches_request_unique').on(
      table.ownerId,
      table.companionId,
      table.runtimeEpoch,
      table.conversationId,
      table.requestId,
    ),
    foreignKey({
      name: 'receive_batches_ref_1',
      columns: [table.ownerId, table.companionId],
      foreignColumns: [companions.ownerId, companions.id],
    }),
    foreignKey({
      name: 'receive_batches_ref_2',
      columns: [table.ownerId, table.conversationId],
      foreignColumns: [conversations.ownerId, conversations.id],
    }),
    check('receive_batches_epoch_positive', sql`${table.runtimeEpoch} > 0`),
    check('receive_batches_messages_array', sql`JSON_TYPE(${table.messages}) = 'ARRAY'`),
  ],
);

/** 恢复权威记录；任务输入与进度保存在主库，领取不依赖进程内队列。 */
export const tasks = mysqlTable(
  'tasks',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id),
    requestKey: varchar('request_key', { length: 180 }).notNull(),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    kind: varchar('kind', { length: 32 }).$type<TaskKind>().notNull(),
    input: json('input').$type<TaskInput>().notNull(),
    scope: json('scope').$type<TaskScope>().notNull(),
    status: varchar('status', { length: 24 }).$type<TaskStatus>().notNull().default('queued'),
    stage: varchar('stage', { length: 64 }).notNull().default('queued'),
    completedSteps: int('completed_steps').notNull().default(0),
    totalSteps: int('total_steps'),
    reason: varchar('reason', { length: 64 }),
    modelCallId: uuid('model_call_id'),
    fence: int('fence').notNull().default(0),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: datetime('lease_expires_at', { fsp: 3 }),
    availableAt: datetime('available_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    createdAt: createdAt(),
    updatedAt: datetime('updated_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    unique('tasks_owner_request').on(table.ownerId, table.requestKey),
    index('tasks_dispatch').on(table.ownerId, table.status, table.availableAt),
    index('tasks_expiry').on(table.ownerId, table.status, table.leaseExpiresAt),
    check(
      'tasks_progress_valid',
      sql`${table.completedSteps} >= 0 AND ${table.fence} >= 0 AND (${table.totalSteps} IS NULL OR ${table.completedSteps} <= ${table.totalSteps})`,
    ),
  ],
);

/** 只追加的调度配置，使用 owner 行锁发布并选择最大版本。 */
export const taskConfigurationVersions = mysqlTable(
  'task_configuration_versions',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id),
    version: int('version').notNull(),
    source: varchar('source', { length: 24 }).$type<'default' | 'deployment'>().notNull(),
    config: json('config').$type<TaskConfiguration>().notNull(),
    requestId: uuid('request_id').notNull(),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('task_config_version').on(table.ownerId, table.version),
    unique('task_config_request').on(table.ownerId, table.requestId),
  ],
);

/** 每次领取都保留配置、截止时间和原因；检查点不覆盖旧尝试的诊断。 */
export const taskAttempts = mysqlTable(
  'task_attempts',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    number: int('number').notNull(),
    configVersion: int('config_version').notNull(),
    config: json('config').$type<TaskConfiguration>().notNull(),
    status: varchar('status', { length: 24 }).$type<Task['attempts'][number]['status']>().notNull(),
    reason: varchar('reason', { length: 64 }),
    startedAt: datetime('started_at', { fsp: 3 }).notNull(),
    deadlineAt: datetime('deadline_at', { fsp: 3 }).notNull(),
    finishedAt: datetime('finished_at', { fsp: 3 }),
  },
  (table) => [unique('task_attempt_number').on(table.ownerId, table.taskId, table.number)],
);

/** 独立调度锁行，避免以 owner 外键行排他锁阻塞消息发布。 */
export const taskSchedulerHeads = mysqlTable('task_scheduler_heads', {
  ownerId: uuid('owner_id')
    .primaryKey()
    .references(() => owners.id),
});

/** 原文发布和待办在同一事务保存，转交任务也与完成标记同事务。 */
export const taskOutbox = mysqlTable(
  'task_outbox',
  {
    id: uuid('id').primaryKey().$defaultFn(randomUUID),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id),
    eventKey: varchar('event_key', { length: 180 }).notNull(),
    kind: varchar('kind', { length: 32 }).$type<'message_published'>().notNull(),
    sourceId: uuid('source_id').notNull(),
    sourceVersion: int('source_version').notNull(),
    payload: json('payload').$type<MessageOutboxInput>().notNull(),
    status: varchar('status', { length: 24 })
      .$type<'pending' | 'dispatched' | 'blocked'>()
      .notNull()
      .default('pending'),
    reason: varchar('reason', { length: 64 }),
    createdAt: createdAt(),
    dispatchedAt: datetime('dispatched_at', { fsp: 3 }),
  },
  (table) => [
    unique('task_outbox_event').on(table.ownerId, table.eventKey),
    index('task_outbox_dispatch').on(table.ownerId, table.status, table.createdAt),
  ],
);
