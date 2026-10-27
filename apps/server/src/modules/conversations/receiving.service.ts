import { API_CODES } from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type {
  CompanionSequenceQuery,
  ConversationProgressResponse,
  MessageListResponse,
  PublishedMessage,
  ReceiveMessagesRequest,
  ReceiveMessagesResponse,
  SourceLookupQuery,
} from '@memory-weave/contracts';
import { and, asc, eq, gt, gte, inArray, lte, or } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import {
  conversationMembers,
  messages,
  processingRanges,
  readReceipts,
  receiveBatches,
  visibilityGrants,
} from '../../database/schema';
import { fingerprint } from '../shared/http';
import {
  assertVisible,
  requireCompanion,
  requireCompanionMember,
  requireConversation,
  toMessage,
} from './conversation-access';
import type { QueryDatabase } from './conversation-access';
import { ApiException } from '../../http/api-exception';

/** 按伴侣当前代次和成员范围提供原文查询，普通查询不登记实际取得。 */
@Injectable()
export class ReceivingService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** 分页查看当前伴侣有权读取的正式发言，排除草稿和其他会话。 */
  listMessages(
    companionId: string,
    conversationId: string,
    input: CompanionSequenceQuery,
  ): Promise<MessageListResponse> {
    return this.database.withOwner(async (ownerId, db) => {
      await requireConversation(ownerId, conversationId, db);
      const member = await requireCompanionMember(
        ownerId,
        companionId,
        input.runtimeEpoch,
        conversationId,
        db,
      );
      const rows = await this.visibleRows(member, input.afterSequence, input.limit + 1, db);
      const page = rows.slice(0, input.limit);
      const items = await Promise.all(page.map((row) => this.publishedMessage(row, db)));
      return {
        items,
        nextAfterSequence: rows.length > input.limit ? (items.at(-1)?.sequence ?? null) : null,
      };
    });
  }

  /** 按确切版本回查有权查看的正式原文，引用本身不授予额外访问权。 */
  source(
    companionId: string,
    messageId: string,
    input: SourceLookupQuery,
  ): Promise<PublishedMessage> {
    return this.database.withOwner(async (ownerId, db) => {
      await requireCompanion(ownerId, companionId, input.runtimeEpoch, db);
      const [row] = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.ownerId, ownerId),
            eq(messages.id, messageId),
            eq(messages.contentVersion, input.contentVersion),
            eq(messages.state, 'published'),
          ),
        )
        .limit(1);
      if (!row || row.sequence === null) {
        throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      }
      const member = await requireCompanionMember(
        ownerId,
        companionId,
        input.runtimeEpoch,
        row.conversationId,
        db,
      );
      await assertVisible(member, row.sequence, db);
      return this.publishedMessage(row, db);
    });
  }

  /** 从各实例持久记录展示读取与待整理状态，查询本身不推进任何进度。 */
  progress(
    companionId: string,
    conversationId: string,
    input: CompanionSequenceQuery,
  ): Promise<ConversationProgressResponse> {
    return this.database.withOwner(async (ownerId, db) => {
      await requireConversation(ownerId, conversationId, db);
      const member = await requireCompanionMember(
        ownerId,
        companionId,
        input.runtimeEpoch,
        conversationId,
        db,
      );
      const rows = await this.visibleRows(member, input.afterSequence, input.limit + 1, db);
      const page = rows.slice(0, input.limit);
      if (page.length === 0) return { items: [], nextAfterSequence: null };
      const ids = page.map((row) => row.id);
      const receipts = await db
        .select()
        .from(readReceipts)
        .where(
          and(
            eq(readReceipts.ownerId, ownerId),
            eq(readReceipts.companionId, companionId),
            eq(readReceipts.runtimeEpoch, input.runtimeEpoch),
            eq(readReceipts.conversationId, conversationId),
            inArray(readReceipts.messageId, ids),
          ),
        );
      const pending = await db
        .select()
        .from(processingRanges)
        .where(
          and(
            eq(processingRanges.ownerId, ownerId),
            eq(processingRanges.companionId, companionId),
            eq(processingRanges.runtimeEpoch, input.runtimeEpoch),
            eq(processingRanges.conversationId, conversationId),
            eq(processingRanges.stage, 'memory_extraction'),
            inArray(processingRanges.messageId, ids),
          ),
        );
      const items = page.map((row) => {
        const processing = pending.find(
          (entry) => entry.messageId === row.id && entry.contentVersion === row.contentVersion,
        );
        if (
          !processing ||
          row.sequence === null ||
          processing.startSequence !== row.sequence ||
          processing.endSequence !== row.sequence
        ) {
          throw new ApiException(API_CODES.DATA_UNAVAILABLE);
        }
        const receipt = receipts.find(
          (entry) => entry.messageId === row.id && entry.contentVersion === row.contentVersion,
        );
        if (receipt && (receipt.startOffset !== 0 || receipt.endOffset !== row.text.length)) {
          throw new ApiException(API_CODES.DATA_UNAVAILABLE);
        }
        return {
          messageId: row.id,
          contentVersion: row.contentVersion,
          sequence: row.sequence,
          readReceipt: receipt
            ? {
                id: receipt.id,
                ownerId: receipt.ownerId,
                companionId: receipt.companionId,
                runtimeEpoch: receipt.runtimeEpoch,
                conversationId: receipt.conversationId,
                messageId: receipt.messageId,
                contentVersion: receipt.contentVersion,
                acquiredAt: receipt.acquiredAt.toISOString(),
                startOffset: 0 as const,
                endOffset: receipt.endOffset,
              }
            : null,
          processing: processing.status,
          delivery: 'not_recorded' as const,
        };
      });
      return {
        items,
        nextAfterSequence: rows.length > input.limit ? (items.at(-1)?.sequence ?? null) : null,
      };
    });
  }

  /** 原子保存确切接收批次及逐条首次取得记录，重试先复核当前权限。 */
  receive(
    companionId: string,
    conversationId: string,
    input: ReceiveMessagesRequest,
  ): Promise<ReceiveMessagesResponse> {
    return this.database.withOwner((ownerId, db) =>
      db.transaction(async (tx) => {
        // 与发布共用会话锁，使并发重试取得同一份批次和首次读取时间。
        await requireConversation(ownerId, conversationId, tx, true);
        const member = await requireCompanionMember(
          ownerId,
          companionId,
          input.runtimeEpoch,
          conversationId,
          tx,
        );
        if (member.permissionVersion !== input.expectedPermissionVersion) {
          throw new ApiException(API_CODES.PERMISSION_VERSION_CONFLICT);
        }
        const requestFingerprint = fingerprint({
          runtimeEpoch: input.runtimeEpoch,
          expectedPermissionVersion: input.expectedPermissionVersion,
          afterSequence: input.afterSequence,
          limit: input.limit,
        });
        const [existing] = await tx
          .select()
          .from(receiveBatches)
          .where(
            and(
              eq(receiveBatches.ownerId, ownerId),
              eq(receiveBatches.companionId, companionId),
              eq(receiveBatches.runtimeEpoch, input.runtimeEpoch),
              eq(receiveBatches.conversationId, conversationId),
              eq(receiveBatches.requestId, input.requestId),
            ),
          )
          .limit(1);
        if (existing) {
          if (existing.fingerprint !== requestFingerprint) {
            throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
          }
          const rows: (typeof messages.$inferSelect)[] = [];
          for (const reference of existing.messages) {
            const [row] = await tx
              .select()
              .from(messages)
              .where(
                and(
                  eq(messages.ownerId, ownerId),
                  eq(messages.conversationId, conversationId),
                  eq(messages.id, reference.messageId),
                  eq(messages.contentVersion, reference.contentVersion),
                  eq(messages.state, 'published'),
                ),
              )
              .limit(1);
            if (!row || row.sequence === null) {
              throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
            }
            await assertVisible(member, row.sequence, tx);
            rows.push(row);
          }
          return this.batchResponse(existing, rows, tx);
        }
        const rows = await this.visibleRows(member, input.afterSequence, input.limit, tx);
        const acquiredAt = new Date();
        const [batch] = await tx
          .insert(receiveBatches)
          .values({
            ownerId,
            companionId,
            runtimeEpoch: input.runtimeEpoch,
            conversationId,
            requestId: input.requestId,
            fingerprint: requestFingerprint,
            messages: rows.map((row) => ({
              messageId: row.id,
              contentVersion: row.contentVersion,
            })),
            acquiredAt,
          })
          .returning();
        if (!batch) throw new Error('Failed to persist the receive batch.');
        if (rows.length > 0) {
          await tx
            .insert(readReceipts)
            .values(
              rows.map((row) => ({
                ownerId,
                companionId,
                runtimeEpoch: input.runtimeEpoch,
                conversationId,
                messageId: row.id,
                contentVersion: row.contentVersion,
                acquiredAt,
                startOffset: 0,
                endOffset: row.text.length,
              })),
            )
            .onConflictDoNothing({
              target: [
                readReceipts.ownerId,
                readReceipts.companionId,
                readReceipts.runtimeEpoch,
                readReceipts.messageId,
                readReceipts.contentVersion,
              ],
            });
        }
        return this.batchResponse(batch, rows, tx);
      }),
    );
  }

  /** 接收响应使用持久批次时间，消息内容沿确切版本映射而不重新选择范围。 */
  private async batchResponse(
    batch: typeof receiveBatches.$inferSelect,
    rows: (typeof messages.$inferSelect)[],
    db: QueryDatabase,
  ): Promise<ReceiveMessagesResponse> {
    const items = await Promise.all(rows.map((row) => this.publishedMessage(row, db)));
    return {
      batchId: batch.id,
      companionId: batch.companionId,
      runtimeEpoch: batch.runtimeEpoch,
      conversationId: batch.conversationId,
      acquiredAt: batch.acquiredAt.toISOString(),
      items,
      nextAfterSequence: items.at(-1)?.sequence ?? null,
    };
  }

  /** 先按当前授权筛选再分页，不能以不可见消息占满页面或泄露草稿。 */
  private async visibleRows(
    member: typeof conversationMembers.$inferSelect,
    afterSequence: number,
    limit: number,
    db: QueryDatabase,
  ): Promise<(typeof messages.$inferSelect)[]> {
    const grants = await db
      .select()
      .from(visibilityGrants)
      .where(
        and(
          eq(visibilityGrants.ownerId, member.ownerId),
          eq(visibilityGrants.membershipId, member.id),
          eq(visibilityGrants.permissionVersion, member.permissionVersion),
        ),
      );
    if (grants.length === 0) return [];
    const ranges = grants.map((grant) => {
      const from =
        grant.kind === 'membership'
          ? Math.max(grant.startSequence, member.joinedSequence)
          : grant.startSequence;
      const until =
        grant.kind === 'membership' && member.leftSequence !== null
          ? Math.min(grant.endSequence ?? member.leftSequence, member.leftSequence)
          : grant.endSequence;
      return and(
        gte(messages.sequence, from),
        until === null ? undefined : lte(messages.sequence, until),
      );
    });
    return db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.ownerId, member.ownerId),
          eq(messages.conversationId, member.conversationId),
          eq(messages.state, 'published'),
          gt(messages.sequence, afterSequence),
          or(...ranges),
        ),
      )
      .orderBy(asc(messages.sequence))
      .limit(limit);
  }

  /** 在映射前确认已发布状态，使伴侣查询不可能返回草稿。 */
  private async publishedMessage(
    row: typeof messages.$inferSelect,
    db: QueryDatabase,
  ): Promise<PublishedMessage> {
    const message = await toMessage(row, db);
    if (message.state !== 'published') throw new Error('Expected a published message.');
    return message;
  }
}
