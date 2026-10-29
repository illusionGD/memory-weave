import { lockTaskScheduler } from '../tasks/task-store';
import { API_CODES } from '@memory-weave/contracts';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  ConversationDetail,
  ConversationListResponse,
  CreateConversationRequest,
  IdPaginationQuery,
  Message,
  MessageListResponse,
  PublishMessageRequest,
  SaveMessageRequest,
  SequencePaginationQuery,
  SpeakerRequest,
} from '@memory-weave/contracts';
import { isNull, and, asc, eq, gt, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service';
import { DatabaseService } from '../../database/database.service';
import {
  chatThreads,
  companions,
  conversationMembers,
  conversations,
  messages,
  messageSources,
  processingRanges,
  visibilityGrants,
} from '../../database/schema';
import { stageMessageOutbox } from '../tasks/task-outbox.service';
import type { MessageOutboxInput } from '../tasks/task-types';
import { fingerprint } from '../shared/http';
import {
  requireCompanion,
  requireCompanionMember,
  requireConversation,
  assertVisible,
  toConversation,
  toMessage,
  toMember,
} from './conversation-access';
import type { QueryDatabase } from './conversation-access';
import { ApiException } from '../../http/api-exception';

/** 管理共享会话与单份原文，所有写入以部署归属及事务保护。 */
@Injectable()
export class ConversationsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** 一次建立初始成员和独立可见授权，不开放邀请及成员变更。 */
  create(input: CreateConversationRequest): Promise<ConversationDetail> {
    return this.database.withOwner((ownerId, db) =>
      db.transaction((tx) => this.createInTransaction(ownerId, tx, input), {
        isolationLevel: 'read committed',
      }),
    );
  }

  /** 供领域命令在同一事务中复用原文规则，不自行提交或调用外部服务。 */
  async createInTransaction(
    ownerId: string,
    tx: DatabaseTransaction,
    input: CreateConversationRequest,
  ): Promise<ConversationDetail> {
    await lockTaskScheduler(ownerId, tx);
    for (const member of input.companions)
      await requireCompanion(ownerId, member.companionId, member.runtimeEpoch, tx);
    const requestFingerprint = fingerprint({
      ...input,
      requestId: undefined,
      companions: input.companions.map((member) => ({
        ...member,
        companionId: member.companionId.toLowerCase(),
      })),
    });
    const id = randomUUID();
    await tx
      .insert(conversations)
      .values({
        id,
        ownerId,
        kind: input.kind,
        title: input.title,
        requestId: input.requestId,
        fingerprint: requestFingerprint,
      })
      .onDuplicateKeyUpdate({ set: { id: sql`${conversations.id}` } });
    const [inserted] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.ownerId, ownerId), eq(conversations.requestId, input.requestId)))
      .limit(1)
      .for('update');
    if (!inserted) throw new ApiException(API_CODES.CONFLICT);
    if (inserted.id !== id) {
      if (inserted.fingerprint !== requestFingerprint)
        throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
      return this.detail(ownerId, inserted.id, tx);
    }
    const members: (typeof conversationMembers.$inferInsert & { id: string })[] =
      input.companions.map((member) => ({
        id: randomUUID(),
        ownerId,
        conversationId: inserted.id,
        kind: 'companion',
        companionId: member.companionId,
        runtimeEpoch: member.runtimeEpoch,
      }));
    if (input.includeUser)
      members.push({
        id: randomUUID(),
        ownerId,
        conversationId: inserted.id,
        kind: 'user',
        userId: ownerId,
      });
    await tx.insert(conversationMembers).values(members);
    await tx.insert(visibilityGrants).values(
      members.map((member) => ({
        ownerId,
        membershipId: member.id,
        startSequence: 1,
        kind: 'membership' as const,
        permissionVersion: 1,
      })),
    );
    return this.detail(ownerId, inserted.id, tx);
  }

  /** 管理者按归属查询会话及成员，不改变任何接收状态。 */
  get(id: string): Promise<ConversationDetail> {
    return this.database.withOwner((ownerId, db) => this.detail(ownerId, id, db));
  }

  /** 按稳定标识分页查询部署内会话，避免一次加载全部历史。 */
  list(input: IdPaginationQuery): Promise<ConversationListResponse> {
    return this.database.withOwner(async (ownerId, db) => {
      const rows = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.ownerId, ownerId),
            input.afterId ? gt(conversations.id, input.afterId) : undefined,
          ),
        )
        .orderBy(asc(conversations.id))
        .limit(input.limit + 1);
      const selected = rows.slice(0, input.limit);
      return {
        items: selected.map(toConversation),
        nextAfterId: rows.length > input.limit ? (selected.at(-1)?.id ?? null) : null,
      };
    });
  }

  /** 只保存单份草稿；验证真实成员及来源后再允许进入共享存储。 */
  save(conversationId: string, input: SaveMessageRequest): Promise<Message> {
    return this.database.withOwner((ownerId, db) =>
      db.transaction(
        async (tx) => {
          await lockTaskScheduler(ownerId, tx);
          await this.assertUnmanaged(ownerId, tx, conversationId);
          return this.saveInTransaction(ownerId, tx, conversationId, input);
        },
        {
          isolationLevel: 'read committed',
        },
      ),
    );
  }

  /** 供领域命令在同一事务中复用原文规则，不自行提交或调用外部服务。 */
  async saveInTransaction(
    ownerId: string,
    tx: DatabaseTransaction,
    conversationId: string,
    input: SaveMessageRequest,
    generated = false,
  ): Promise<Message> {
    const conversation = await requireConversation(ownerId, conversationId, tx, true);
    const member = await this.speaker(ownerId, conversationId, input.speaker, tx);
    const requestFingerprint = fingerprint({
      ...input,
      requestId: undefined,
      speaker:
        input.speaker.kind === 'companion'
          ? { ...input.speaker, companionId: input.speaker.companionId.toLowerCase() }
          : input.speaker,
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
      occurredAt: input.occurredAt ?? null,
      replyToMessageId: input.replyToMessageId?.toLowerCase() ?? null,
      sources: input.sources.map((source) => ({
        ...source,
        messageId: source.messageId.toLowerCase(),
      })),
    });
    await this.validateReferences(
      ownerId,
      conversationId,
      member,
      input.replyToMessageId ?? null,
      input.sources,
      tx,
    );
    const [existing] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.ownerId, ownerId),
          eq(messages.conversationId, conversationId),
          eq(messages.requestId, input.requestId),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.fingerprint !== requestFingerprint)
        throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
      return toMessage(existing, tx);
    }
    if (conversation.version !== input.expectedConversationVersion)
      throw new ApiException(API_CODES.VERSION_CONFLICT);
    const receivedAt = new Date();
    const messageId = randomUUID();
    await tx.insert(messages).values({
      id: messageId,
      ownerId,
      conversationId,
      speakerMembershipId: member.id,
      requestId: input.requestId,
      fingerprint: requestFingerprint,
      text: input.text,
      receivedAt,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : null,
      validFrom: input.validFrom ? new Date(input.validFrom) : null,
      validUntil: input.validUntil ? new Date(input.validUntil) : null,
      epistemicKind: input.epistemicKind,
      reality: input.reality,
      sourceKind:
        member.kind === 'user'
          ? 'user_input'
          : generated
            ? 'model_output'
            : 'admin_companion_input',
      replyToMessageId: input.replyToMessageId ?? null,
    });
    const [row] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.ownerId, ownerId), eq(messages.id, messageId)))
      .limit(1);
    if (!row) throw new ApiException(API_CODES.CONFLICT);
    if (input.sources.length > 0)
      await tx.insert(messageSources).values(
        input.sources.map((source) => ({
          ownerId,
          messageId: row.id,
          sourceMessageId: source.messageId,
          sourceContentVersion: source.contentVersion,
          relation: source.relation,
        })),
      );
    return toMessage(row, tx);
  }

  /** 管理查询可查看草稿，但不会使草稿正式发布或登记接收。 */
  getMessage(conversationId: string, messageId: string): Promise<Message> {
    return this.database.withOwner(async (ownerId, db) => {
      await requireConversation(ownerId, conversationId, db);
      const [row] = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.ownerId, ownerId),
            eq(messages.conversationId, conversationId),
            eq(messages.id, messageId),
          ),
        )
        .limit(1);
      if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      return toMessage(row, db);
    });
  }

  /** 正式发布与各可见实例待整理登记原子提交，重试复用原发布结果。 */
  publish(
    conversationId: string,
    messageId: string,
    input: PublishMessageRequest,
  ): Promise<Message> {
    return this.database.withOwner((ownerId, db) =>
      db.transaction(
        async (tx) => {
          await lockTaskScheduler(ownerId, tx);
          await this.assertUnmanaged(ownerId, tx, conversationId);
          return this.publishInTransaction(ownerId, tx, conversationId, messageId, input);
        },
        { isolationLevel: 'read committed' },
      ),
    );
  }

  /** 供领域命令在同一事务中复用原文规则，不自行提交或调用外部服务。 */
  async publishInTransaction(
    ownerId: string,
    tx: DatabaseTransaction,
    conversationId: string,
    messageId: string,
    input: PublishMessageRequest,
  ): Promise<Message> {
    const conversation = await requireConversation(ownerId, conversationId, tx, true);
    const [row] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.ownerId, ownerId),
          eq(messages.conversationId, conversationId),
          eq(messages.id, messageId),
        ),
      )
      .limit(1);
    if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    const original = await toMessage(row, tx);
    const member = await this.speaker(ownerId, conversationId, original.speaker, tx);
    await this.validateReferences(
      ownerId,
      conversationId,
      member,
      row.replyToMessageId,
      original.sources,
      tx,
    );
    const requestFingerprint = fingerprint({
      expectedRevision: input.expectedRevision,
      expectedConversationVersion: input.expectedConversationVersion,
    });
    if (row.deletedAt) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    if (row.state === 'published') {
      if (
        row.publishRequestId !== input.requestId.toLowerCase() ||
        row.publishFingerprint !== requestFingerprint
      ) {
        throw new ApiException(API_CODES.MESSAGE_ALREADY_PUBLISHED);
      }
      return original;
    }
    if (
      row.revision !== input.expectedRevision ||
      conversation.version !== input.expectedConversationVersion
    ) {
      throw new ApiException(API_CODES.VERSION_CONFLICT);
    }
    if (
      conversation.lastSequence >= 2_147_483_647 ||
      conversation.version >= 2_147_483_647 ||
      row.revision >= 2_147_483_647
    ) {
      throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
    }
    const sequence = conversation.lastSequence + 1;
    await assertVisible(member, sequence, tx);
    const publishedAt = new Date();
    await tx
      .update(messages)
      .set({
        state: 'published',
        sequence,
        publishedAt,
        revision: row.revision + 1,
        publishRequestId: input.requestId,
        publishFingerprint: requestFingerprint,
      })
      .where(and(eq(messages.ownerId, ownerId), eq(messages.id, messageId)));
    const [published] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.ownerId, ownerId), eq(messages.id, messageId)))
      .limit(1);
    if (!published) throw new ApiException(API_CODES.CONFLICT);
    await tx
      .update(conversations)
      .set({ lastSequence: sequence, version: conversation.version + 1 })
      .where(and(eq(conversations.ownerId, ownerId), eq(conversations.id, conversationId)));
    const recipients = await tx
      .select({ member: conversationMembers })
      .from(conversationMembers)
      .innerJoin(
        companions,
        and(
          eq(companions.ownerId, conversationMembers.ownerId),
          eq(companions.id, conversationMembers.companionId),
          eq(companions.runtimeEpoch, conversationMembers.runtimeEpoch),
          isNull(companions.deletedAt),
          isNull(companions.lifecycleOperationId),
        ),
      )
      .where(
        and(
          eq(conversationMembers.ownerId, ownerId),
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.kind, 'companion'),
        ),
      );
    const outboxRecipients: MessageOutboxInput['recipients'] = [];
    for (const { member: recipient } of recipients) {
      try {
        await assertVisible(recipient, sequence, tx);
      } catch (error) {
        if (error instanceof ApiException && error.code === API_CODES.RESOURCE_NOT_FOUND) continue;
        throw error;
      }
      if (recipient.companionId === null || recipient.runtimeEpoch === null) continue;
      outboxRecipients.push({
        companionId: recipient.companionId,
        runtimeEpoch: recipient.runtimeEpoch,
        permissionVersion: recipient.permissionVersion,
      });
      await tx.insert(processingRanges).values({
        ownerId,
        companionId: recipient.companionId,
        runtimeEpoch: recipient.runtimeEpoch,
        conversationId,
        messageId,
        contentVersion: row.contentVersion,
        startSequence: sequence,
        endSequence: sequence,
        createdAt: publishedAt,
      });
    }
    await stageMessageOutbox(ownerId, tx, {
      conversationId,
      messageId,
      contentVersion: row.contentVersion,
      sequence,
      recipients: outboxRecipients,
    });
    return toMessage(published, tx);
  }

  /** 管理历史只返回正式发布消息，按服务端序号分页。 */
  listMessages(
    conversationId: string,
    input: SequencePaginationQuery,
  ): Promise<MessageListResponse> {
    return this.database.withOwner(async (ownerId, db) => {
      await requireConversation(ownerId, conversationId, db);
      const rows = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.ownerId, ownerId),
            eq(messages.conversationId, conversationId),
            eq(messages.state, 'published'),
            gt(messages.sequence, input.afterSequence),
          ),
        )
        .orderBy(asc(messages.sequence))
        .limit(input.limit + 1);
      const selected = rows.slice(0, input.limit);
      const mapped = await Promise.all(selected.map((row) => toMessage(row, db)));
      return {
        items: mapped.filter((row) => row.state === 'published'),
        nextAfterSequence: rows.length > input.limit ? (selected.at(-1)?.sequence ?? null) : null,
      };
    });
  }

  /** 聊天的写入必须同时失效旧回复，基础管理接口不能旁路该协议。 */
  private async assertUnmanaged(
    ownerId: string,
    tx: DatabaseTransaction,
    conversationId: string,
  ): Promise<void> {
    await requireConversation(ownerId, conversationId, tx, true);
    const [chat] = await tx
      .select({ id: chatThreads.conversationId })
      .from(chatThreads)
      .where(and(eq(chatThreads.ownerId, ownerId), eq(chatThreads.conversationId, conversationId)));
    if (chat) throw new ApiException(API_CODES.CHAT_MANAGED_CONVERSATION);
  }

  /** 保存与发布均核对实际发言者，管理者代理不扩大成员访问权。 */
  private async speaker(
    ownerId: string,
    conversationId: string,
    input: SpeakerRequest,
    db: QueryDatabase,
  ): Promise<typeof conversationMembers.$inferSelect> {
    if (input.kind === 'companion') {
      const member = await requireCompanionMember(
        ownerId,
        input.companionId,
        input.runtimeEpoch,
        conversationId,
        db,
      );
      if (member.leftSequence !== null) throw new ApiException(API_CODES.MEMBER_LEFT);
      return member;
    }
    const [member] = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.ownerId, ownerId),
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.kind, 'user'),
          eq(conversationMembers.userId, ownerId),
        ),
      )
      .limit(1);
    if (!member || member.leftSequence !== null)
      throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    return member;
  }

  /** 来源和回复必须指向本会话内发言者有权查看的已发布原文。 */
  private async validateReferences(
    ownerId: string,
    conversationId: string,
    member: typeof conversationMembers.$inferSelect,
    replyToMessageId: string | null,
    sources: SaveMessageRequest['sources'],
    db: QueryDatabase,
  ): Promise<void> {
    const refs: { messageId: string; contentVersion?: number }[] = [...sources];
    if (replyToMessageId) refs.push({ messageId: replyToMessageId });
    for (const reference of refs) {
      const [row] = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.ownerId, ownerId),
            eq(messages.conversationId, conversationId),
            eq(messages.id, reference.messageId),
            eq(messages.state, 'published'),
            isNull(messages.deletedAt),
            reference.contentVersion === undefined
              ? undefined
              : eq(messages.contentVersion, reference.contentVersion),
          ),
        )
        .limit(1);
      if (!row || row.sequence === null) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      await assertVisible(member, row.sequence, db);
    }
  }

  /** 返回稳定公共字段，成员按标识排序使重复查询结果稳定。 */
  private async detail(
    ownerId: string,
    id: string,
    db: QueryDatabase,
  ): Promise<ConversationDetail> {
    const row = await requireConversation(ownerId, id, db);
    const members = await db
      .select()
      .from(conversationMembers)
      .where(
        and(eq(conversationMembers.ownerId, ownerId), eq(conversationMembers.conversationId, id)),
      )
      .orderBy(asc(conversationMembers.id));
    return { conversation: toConversation(row), members: members.map(toMember) };
  }
}
