import { Inject, Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import type { Message, ShareBackground } from '@memory-weave/contracts';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { messages, messageSources } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { TaskStore } from '../tasks/task-store';
import { assertVisible, requireConversation, toMessage } from './conversation-access';
import { ConversationsService } from './conversations.service';
import { requireOpenConversation } from './membership-store';
import { fingerprint } from '../shared/http';

/** 用户明确选取背景片段，接收者只获得发布的片段。 */
@Injectable()
export class ConversationBackground {
  /** 初始化背景发布与来源核对。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(ConversationsService) private readonly conversations: ConversationsService,
  ) {}

  /** 发布有出处的实际引文，无任何自动跨会话授权。 */
  share(ownerId: string, conversationId: string, command: ShareBackground): Promise<Message> {
    return this.store.locked(ownerId, async (tx) => {
      const requestId = command.requestId.toLowerCase();
      const originalId = command.messageId.toLowerCase();
      const origin = command.sourceConversationId.toLowerCase();
      if (origin === conversationId) throw new ApiException(API_CODES.INVALID_REQUEST);
      await requireConversation(ownerId, origin, tx);
      const destination = await requireOpenConversation(ownerId, conversationId, tx);
      if (destination.kind !== 'group') throw new ApiException(API_CODES.ACCESS_DENIED);
      const member = await this.database.conversationMembers.findOne(
        ownerId,
        {
          where: { conversationId: origin, kind: 'user', userId: ownerId },
        },
        tx,
      );
      const source = await this.database.messages.findOne(
        ownerId,
        {
          where: {
            conversationId: origin,
            id: originalId,
            contentVersion: command.contentVersion,
            state: 'published',
            deletedAt: null,
          },
        },
        tx,
      );
      if (!member || source?.sequence == null) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      await assertVisible(member, source.sequence, tx);
      const text = source.text.slice(command.startOffset, command.endOffset);
      if (
        !text.trim() ||
        command.endOffset > source.text.length ||
        /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(text)
      )
        throw new ApiException(API_CODES.INVALID_REQUEST);
      const hash = fingerprint({
        ...command,
        requestId,
        originalId,
        origin,
        action: 'share_background',
      });
      const existing = await this.database.messages.findOne(
        ownerId,
        {
          where: { conversationId, requestId },
        },
        tx,
      );
      if (existing) {
        // 发布指纹用于此领域命令的精确范围，防止同键改换引文边界。
        if (existing.fingerprint !== hash || existing.deletedAt)
          throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return toMessage(ownerId, this.database, existing, tx);
      }
      const draft = await this.conversations.saveInTransaction(ownerId, tx, conversationId, {
        requestId,
        expectedConversationVersion: command.expectedConversationVersion,
        speaker: { kind: 'user' },
        text,
        epistemicKind: 'report',
        reality: source.reality,
        occurredAt: source.occurredAt?.toISOString(),
        validFrom: source.validFrom?.toISOString(),
        validUntil: source.validUntil?.toISOString(),
        sources: [],
      });
      await this.conversations.publishInTransaction(ownerId, tx, conversationId, draft.id, {
        requestId,
        expectedRevision: draft.revision,
        expectedConversationVersion: command.expectedConversationVersion,
      });
      await tx
        .update(messages)
        .set({ fingerprint: hash })
        .where(and(eq(messages.ownerId, ownerId), eq(messages.id, draft.id)));
      await tx.insert(messageSources).values({
        ownerId,
        messageId: draft.id,
        sourceMessageId: source.id,
        sourceContentVersion: source.contentVersion,
        relation: 'report',
      });
      const published = await this.database.messages.findById(ownerId, draft.id, tx);
      return toMessage(ownerId, this.database, published!, tx);
    });
  }
}
