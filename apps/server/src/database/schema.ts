import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { PgTableExtraConfigValue } from 'drizzle-orm/pg-core';

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

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** 当前部署唯一的管理者；迁移生成身份，请求不能指定部署身份。 */
export const owners = pgTable(
  'owners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deploymentKey: text('deployment_key').notNull().unique().default('local'),
    /** 供界面展示的当前名称；改名不改变身份或覆盖历史发言。 */
    displayName: text('display_name').notNull().default('用户'),
    createdAt: createdAt(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'owners_display_name_length',
      sql`char_length(btrim(${table.displayName})) BETWEEN 1 AND 80`,
    ),
  ],
);

/** 稳定实例及其当前运行代次；共同会话原文不级联归属于实例。 */
export const companions = pgTable(
  'companions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id),
    name: text('name').notNull(),
    runtimeEpoch: integer('runtime_epoch').notNull().default(1),
    version: integer('version').notNull().default(1),
    initialSnapshot: jsonb('initial_snapshot').$type<InitialSnapshot>().notNull(),
    currentPersonaVersionId: uuid('current_persona_version_id'),
    requestId: uuid('request_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    createdAt: createdAt(),
  },
  (table): PgTableExtraConfigValue[] => [
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
export const personaVersions = pgTable(
  'persona_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull(),
    companionId: uuid('companion_id').notNull(),
    runtimeEpoch: integer('runtime_epoch').notNull(),
    version: integer('version').notNull(),
    profileText: text('profile_text').notNull(),
    createdAt: createdAt(),
  },
  (table): PgTableExtraConfigValue[] => [
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
    foreignKey({
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

/** 会话保存共享顺序；发布命令在事务中锁定该行后分配序号。 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id),
    kind: text('kind', { enum: ['private', 'group'] }).notNull(),
    title: text('title').notNull(),
    version: integer('version').notNull().default(1),
    lastSequence: integer('last_sequence').notNull().default(0),
    requestId: uuid('request_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
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
export const conversationMembers = pgTable(
  'conversation_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    kind: text('kind', { enum: ['user', 'companion'] }).notNull(),
    userId: uuid('user_id'),
    companionId: uuid('companion_id'),
    runtimeEpoch: integer('runtime_epoch'),
    joinedSequence: integer('joined_sequence').notNull().default(1),
    leftSequence: integer('left_sequence'),
    permissionVersion: integer('permission_version').notNull().default(1),
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
      columns: [table.ownerId, table.conversationId],
      foreignColumns: [conversations.ownerId, conversations.id],
    }),
    foreignKey({
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
export const visibilityGrants = pgTable(
  'visibility_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    startSequence: integer('start_sequence').notNull(),
    endSequence: integer('end_sequence'),
    kind: text('kind', { enum: ['membership', 'history'] }).notNull(),
    permissionVersion: integer('permission_version').notNull(),
  },
  (table) => [
    foreignKey({
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
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    speakerMembershipId: uuid('speaker_membership_id').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    contentVersion: integer('content_version').notNull().default(1),
    revision: integer('revision').notNull().default(1),
    text: text('text').notNull(),
    state: text('state', { enum: ['draft', 'published'] })
      .notNull()
      .default('draft'),
    sequence: integer('sequence'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    epistemicKind: text('epistemic_kind', { enum: ['statement', 'report', 'inference', 'setting'] })
      .notNull()
      .default('statement'),
    reality: text('reality', { enum: ['unspecified', 'real', 'fictional'] })
      .notNull()
      .default('unspecified'),
    sourceKind: text('source_kind', { enum: ['user_input', 'admin_companion_input'] }).notNull(),
    replyToMessageId: uuid('reply_to_message_id'),
    requestId: uuid('request_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    publishRequestId: uuid('publish_request_id'),
    publishFingerprint: text('publish_fingerprint'),
  },
  (table): PgTableExtraConfigValue[] => [
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
      columns: [table.ownerId, table.conversationId],
      foreignColumns: [conversations.ownerId, conversations.id],
    }),
    foreignKey({
      columns: [table.ownerId, table.conversationId, table.speakerMembershipId],
      foreignColumns: [
        conversationMembers.ownerId,
        conversationMembers.conversationId,
        conversationMembers.id,
      ],
    }),
    foreignKey({
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
export const messageSources = pgTable(
  'message_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull(),
    messageId: uuid('message_id').notNull(),
    sourceMessageId: uuid('source_message_id').notNull(),
    sourceContentVersion: integer('source_content_version').notNull(),
    relation: text('relation', { enum: ['reference', 'report'] }).notNull(),
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
      columns: [table.ownerId, table.messageId],
      foreignColumns: [messages.ownerId, messages.id],
    }),
    foreignKey({
      columns: [table.ownerId, table.sourceMessageId, table.sourceContentVersion],
      foreignColumns: [messages.ownerId, messages.id, messages.contentVersion],
    }),
    check('message_sources_relation_valid', sql`${table.relation} IN ('reference', 'report')`),
    check('message_sources_not_self', sql`${table.messageId} <> ${table.sourceMessageId}`),
  ],
);

/** 每个实例实际取得的正文范围；查询与发布不会写入此表。 */
export const readReceipts = pgTable(
  'read_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull(),
    companionId: uuid('companion_id').notNull(),
    runtimeEpoch: integer('runtime_epoch').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    messageId: uuid('message_id').notNull(),
    contentVersion: integer('content_version').notNull(),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
    startOffset: integer('start_offset').notNull(),
    endOffset: integer('end_offset').notNull(),
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
      columns: [table.ownerId, table.companionId],
      foreignColumns: [companions.ownerId, companions.id],
    }),
    foreignKey({
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
export const processingRanges = pgTable(
  'processing_ranges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull(),
    companionId: uuid('companion_id').notNull(),
    runtimeEpoch: integer('runtime_epoch').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    messageId: uuid('message_id').notNull(),
    contentVersion: integer('content_version').notNull(),
    startSequence: integer('start_sequence').notNull(),
    endSequence: integer('end_sequence').notNull(),
    stage: text('stage', { enum: ['memory_extraction'] })
      .notNull()
      .default('memory_extraction'),
    status: text('status', { enum: ['pending'] })
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
      columns: [table.ownerId, table.companionId],
      foreignColumns: [companions.ownerId, companions.id],
    }),
    foreignKey({
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
export const receiveBatches = pgTable(
  'receive_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull(),
    companionId: uuid('companion_id').notNull(),
    runtimeEpoch: integer('runtime_epoch').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    requestId: uuid('request_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    messages: jsonb('messages').$type<ReceivedMessageVersion[]>().notNull(),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
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
      columns: [table.ownerId, table.companionId],
      foreignColumns: [companions.ownerId, companions.id],
    }),
    foreignKey({
      columns: [table.ownerId, table.conversationId],
      foreignColumns: [conversations.ownerId, conversations.id],
    }),
    check('receive_batches_epoch_positive', sql`${table.runtimeEpoch} > 0`),
    check('receive_batches_messages_array', sql`jsonb_typeof(${table.messages}) = 'array'`),
  ],
);
