import { Inject, Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import type {
  HistoryDecision,
  HistoryRequest,
  HistoryShare,
  HistoryShareList,
  IdPaginationQuery,
} from '@memory-weave/contracts';
import { and, asc, between, eq, gt, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '../../database/database.service';
import { DatabaseService } from '../../database/database.service';
import { conversationHistoryShares, messages, processingRanges } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { fingerprint } from '../shared/http';
import { TaskStore } from '../tasks/task-store';
import { requireCompanion, requireConversation } from './conversation-access';
import {
  membership,
  replayMembershipCommand,
  requireOpenConversation,
  rewriteMembershipGrants,
  saveMembershipCommand,
} from './membership-store';
import type { MemberRow } from './membership-store';

type Share = typeof conversationHistoryShares.$inferSelect;

/** 显式批准给本会话具体成员的历史范围，原文始终留在共同会话。 */
@Injectable()
export class ConversationHistory {
  /** 初始化历史范围管理。 */
  constructor(
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  /** 登记待审批范围，不提前授予历史。 */
  request(ownerId: string, conversationId: string, command: HistoryRequest): Promise<HistoryShare> {
    return this.store.locked(ownerId, async (tx, now) => {
      const requestId = command.requestId.toLowerCase();
      const membershipId = command.membershipId.toLowerCase();
      const hash = fingerprint({ ...command, requestId, membershipId, conversationId });
      await requireConversation(ownerId, conversationId, tx);
      const [replay] = await tx
        .select()
        .from(conversationHistoryShares)
        .where(
          and(
            eq(conversationHistoryShares.ownerId, ownerId),
            eq(conversationHistoryShares.requestId, requestId),
          ),
        )
        .limit(1);
      if (replay) {
        if (replay.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return historyView(replay);
      }
      const conversation = await requireOpenConversation(ownerId, conversationId, tx);
      const member = await membership(ownerId, conversationId, membershipId, tx);
      if (member.permissionVersion !== command.expectedPermissionVersion)
        throw new ApiException(API_CODES.PERMISSION_VERSION_CONFLICT);
      if (
        member.kind !== 'companion' ||
        member.leftSequence !== null ||
        conversation.kind !== 'group'
      )
        throw new ApiException(API_CODES.ACCESS_DENIED);
      if (
        command.range.through >= member.joinedSequence ||
        command.range.through > conversation.lastSequence
      )
        throw new ApiException(API_CODES.INVALID_REQUEST);
      await requireCompanion(this.database, ownerId, member.companionId!, member.runtimeEpoch!, tx);
      const id = randomUUID();
      await tx.insert(conversationHistoryShares).values({
        id,
        ownerId,
        conversationId,
        membershipId,
        requestId,
        fingerprint: hash,
        version: 1,
        state: 'pending',
        permissionVersion: member.permissionVersion,
        fromSequence: command.range.from,
        throughSequence: command.range.through,
        createdAt: now,
      });
      return historyView(await this.row(ownerId, conversationId, id, tx));
    });
  }

  /** 按范围批准、拒绝或撤销，并只补开放后尚未整理的消息。 */
  decide(
    ownerId: string,
    conversationId: string,
    id: string,
    command: HistoryDecision,
  ): Promise<HistoryShare> {
    return this.store.locked(ownerId, async (tx, now) => {
      await requireConversation(ownerId, conversationId, tx);
      const requestId = command.requestId.toLowerCase();
      const hash = fingerprint({ ...command, requestId, id, action: 'history_decision' });
      const replay = await replayMembershipCommand<HistoryShare>(
        ownerId,
        conversationId,
        requestId,
        hash,
        tx,
      );
      if (replay) return replay;
      const row = await this.row(ownerId, conversationId, id, tx);
      if (row.version !== command.expectedVersion)
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      const decision = command.decision;
      if (
        (decision === 'revoke' && row.state !== 'approved') ||
        (decision !== 'revoke' && row.state !== 'pending')
      )
        throw new ApiException(API_CODES.CONFLICT);
      const member = await membership(ownerId, conversationId, row.membershipId, tx);
      if (decision === 'approve') {
        await requireOpenConversation(ownerId, conversationId, tx);
        await requireCompanion(
          this.database,
          ownerId,
          member.companionId!,
          member.runtimeEpoch!,
          tx,
        );
        if (member.permissionVersion !== row.permissionVersion || member.leftSequence !== null)
          throw new ApiException(API_CODES.PERMISSION_VERSION_CONFLICT);
      }
      if (row.version >= 2_147_483_647) throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
      const version = row.version + 1;
      const state =
        decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'revoked';
      await tx
        .update(conversationHistoryShares)
        .set({ version, state })
        .where(
          and(eq(conversationHistoryShares.ownerId, ownerId), eq(conversationHistoryShares.id, id)),
        );
      const changed =
        decision === 'reject' ? member : await rewriteMembershipGrants(member, {}, tx);
      const queuedMessages = decision === 'approve' ? await this.queueMissing(changed, row, tx) : 0;
      const result = historyView({
        ...row,
        version,
        state,
        queuedMessages,
        permissionVersion: changed.permissionVersion,
      });
      await tx
        .update(conversationHistoryShares)
        .set({ queuedMessages, permissionVersion: changed.permissionVersion })
        .where(
          and(eq(conversationHistoryShares.ownerId, ownerId), eq(conversationHistoryShares.id, id)),
        );
      return saveMembershipCommand(ownerId, conversationId, requestId, hash, result, now, tx);
    });
  }

  /** 查看审批状态、范围和已登记补处理的数量。 */
  list(
    ownerId: string,
    conversationId: string,
    query: IdPaginationQuery,
  ): Promise<HistoryShareList> {
    return this.store.locked(ownerId, async (tx) => {
      await requireConversation(ownerId, conversationId, tx);
      const rows = await tx
        .select()
        .from(conversationHistoryShares)
        .where(
          and(
            eq(conversationHistoryShares.ownerId, ownerId),
            eq(conversationHistoryShares.conversationId, conversationId),
            query.afterId ? gt(conversationHistoryShares.id, query.afterId) : undefined,
          ),
        )
        .orderBy(asc(conversationHistoryShares.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      return {
        items: page.map(historyView),
        nextAfterId: rows.length > query.limit ? page.at(-1)!.id : null,
      };
    });
  }

  /** 图片或正文等来源仍使用已经发布的消息版本，不把批准记为实际读取。 */
  private async queueMissing(
    member: MemberRow,
    share: Share,
    tx: DatabaseTransaction,
  ): Promise<number> {
    const { ownerId, companionId, runtimeEpoch, conversationId } = member;
    const missing = await tx
      .select({
        messageId: messages.id,
        contentVersion: messages.contentVersion,
        sequence: messages.sequence,
      })
      .from(messages)
      .leftJoin(
        processingRanges,
        and(
          eq(processingRanges.ownerId, ownerId),
          eq(processingRanges.companionId, companionId!),
          eq(processingRanges.runtimeEpoch, runtimeEpoch!),
          eq(processingRanges.conversationId, conversationId),
          eq(processingRanges.messageId, messages.id),
          eq(processingRanges.contentVersion, messages.contentVersion),
        ),
      )
      .where(
        and(
          eq(messages.ownerId, ownerId),
          eq(messages.conversationId, conversationId),
          eq(messages.state, 'published'),
          between(messages.sequence, share.fromSequence, share.throughSequence),
          isNull(messages.deletedAt),
          isNull(processingRanges.id),
        ),
      )
      .orderBy(asc(messages.sequence))
      .limit(100);
    if (missing.length)
      await tx.insert(processingRanges).values(
        missing.map((row) => ({
          ownerId,
          companionId: companionId!,
          runtimeEpoch: runtimeEpoch!,
          conversationId,
          messageId: row.messageId,
          contentVersion: row.contentVersion,
          startSequence: row.sequence!,
          endSequence: row.sequence!,
        })),
      );
    return missing.length;
  }

  /** 只读取被管理会话中的审批。 */
  private async row(
    ownerId: string,
    conversationId: string,
    id: string,
    tx: DatabaseTransaction,
  ): Promise<Share> {
    const [row] = await tx
      .select()
      .from(conversationHistoryShares)
      .where(
        and(
          eq(conversationHistoryShares.ownerId, ownerId),
          eq(conversationHistoryShares.conversationId, conversationId),
          eq(conversationHistoryShares.id, id),
        ),
      )
      .limit(1);
    if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    return row;
  }
}

/** 序号范围与当前实际权限版本供调用方查看。 */
function historyView(row: Share): HistoryShare {
  return {
    id: row.id,
    conversationId: row.conversationId,
    membershipId: row.membershipId,
    range: { from: row.fromSequence, through: row.throughSequence },
    version: row.version,
    permissionVersion: row.permissionVersion,
    state: row.state,
    queuedMessages: row.queuedMessages,
    createdAt: row.createdAt.toISOString(),
  };
}
