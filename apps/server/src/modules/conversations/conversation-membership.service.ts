import { interruptGroupTurn } from '../group-turns/group-turn-store';
import { Inject, Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import type {
  Conversation,
  ConversationClose,
  MemberExit,
  MemberExitResult,
  MembershipPolicy,
} from '@memory-weave/contracts';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service';
import { tasks } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { fingerprint } from '../shared/http';
import { TaskStore } from '../tasks/task-store';
import { TasksService } from '../tasks/tasks.service';
import { requireConversation, toConversation } from './conversation-access';
import {
  activeMemberships,
  advanceConversation,
  membership,
  replayMembershipCommand,
  requireOpenConversation,
  rewriteMembershipGrants,
  saveMembershipCommand,
} from './membership-store';

/** 管理成员离开、配置和结束会话，历史授权保留到确切边界。 */
@Injectable()
export class ConversationMembership {
  /** 初始化成员控制。 */
  constructor(
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(TasksService) private readonly jobs: TasksService,
  ) {}

  /** 管理员移除伴侣或退出自己的成员身份。 */
  exit(
    ownerId: string,
    conversationId: string,
    membershipId: string,
    command: MemberExit,
  ): Promise<MemberExitResult> {
    return this.store.locked(ownerId, (tx, now) =>
      this.exitInTransaction(ownerId, conversationId, membershipId, command, 'owner', tx, now),
    );
  }

  /** 实际的退出决策由调用方证明，结束未发布发言而保留旧经历。 */
  async exitInTransaction(
    ownerId: string,
    conversationId: string,
    membershipId: string,
    command: MemberExit,
    actor: 'owner' | 'companion',
    tx: DatabaseTransaction,
    now: Date,
  ): Promise<MemberExitResult> {
    await requireConversation(ownerId, conversationId, tx);
    const requestId = command.requestId.toLowerCase();
    const hash = fingerprint({ ...command, requestId, membershipId, actor, action: 'leave' });
    const replay = await replayMembershipCommand<MemberExitResult>(
      ownerId,
      conversationId,
      requestId,
      hash,
      tx,
    );
    if (replay) return replay;
    const conversation = await requireOpenConversation(ownerId, conversationId, tx);
    const member = await membership(ownerId, conversationId, membershipId, tx);
    if (conversation.version !== command.expectedConversationVersion)
      throw new ApiException(API_CODES.VERSION_CONFLICT);
    if (member.permissionVersion !== command.expectedPermissionVersion)
      throw new ApiException(API_CODES.PERMISSION_VERSION_CONFLICT);
    if (member.leftSequence !== null) throw new ApiException(API_CODES.MEMBER_LEFT);
    if (actor === 'companion' && member.kind !== 'companion')
      throw new ApiException(API_CODES.ACCESS_DENIED);
    const removed = member.kind === 'companion' && actor === 'owner';
    const next = await rewriteMembershipGrants(
      member,
      {
        leftSequence: conversation.lastSequence,
        removedAt: removed ? now : null,
      },
      tx,
    );
    const closed = conversation.kind === 'private';
    const updated = await advanceConversation(conversation, tx, closed ? { closedAt: now } : {});
    if (closed || member.companionId)
      await this.cancelReplies(
        ownerId,
        conversationId,
        closed ? null : member.companionId,
        tx,
        now,
      );
    return saveMembershipCommand(
      ownerId,
      conversationId,
      requestId,
      hash,
      {
        membershipId,
        removed,
        leftSequence: conversation.lastSequence,
        permissionVersion: next.permissionVersion,
        conversationVersion: updated.version,
      },
      now,
      tx,
    );
  }

  /** 按用户意愿结束本会话的后续发言，不删除原有已发布内容。 */
  close(
    ownerId: string,
    conversationId: string,
    command: ConversationClose,
  ): Promise<Conversation> {
    return this.store.locked(ownerId, async (tx, now) => {
      await requireConversation(ownerId, conversationId, tx);
      const requestId = command.requestId.toLowerCase();
      const hash = fingerprint({ ...command, requestId, action: 'close' });
      const replay = await replayMembershipCommand<Conversation>(
        ownerId,
        conversationId,
        requestId,
        hash,
        tx,
      );
      if (replay) return replay;
      const conversation = await requireOpenConversation(ownerId, conversationId, tx);
      if (conversation.version !== command.expectedConversationVersion)
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      for (const member of await activeMemberships(ownerId, conversationId, tx)) {
        await rewriteMembershipGrants(member, { leftSequence: conversation.lastSequence }, tx);
      }
      const closed = await advanceConversation(conversation, tx, { closedAt: now });
      await this.cancelReplies(ownerId, conversationId, null, tx, now);
      return saveMembershipCommand(
        ownerId,
        conversationId,
        requestId,
        hash,
        toConversation(closed),
        now,
        tx,
      );
    });
  }

  /** 修改同伴邀请权限，已经发出的未决邀请也必须重新遵守。 */
  policy(
    ownerId: string,
    conversationId: string,
    command: MembershipPolicy,
  ): Promise<Conversation> {
    return this.store.locked(ownerId, async (tx, now) => {
      await requireConversation(ownerId, conversationId, tx);
      const requestId = command.requestId.toLowerCase();
      const hash = fingerprint({ ...command, requestId, action: 'membership_policy' });
      const replay = await replayMembershipCommand<Conversation>(
        ownerId,
        conversationId,
        requestId,
        hash,
        tx,
      );
      if (replay) return replay;
      const conversation = await requireOpenConversation(ownerId, conversationId, tx);
      if (conversation.version !== command.expectedConversationVersion)
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      const updated = await advanceConversation(conversation, tx, {
        peerInvitationsEnabled: command.peerInvitationsEnabled,
      });
      return saveMembershipCommand(
        ownerId,
        conversationId,
        requestId,
        hash,
        toConversation(updated),
        now,
        tx,
      );
    });
  }

  /** 撤销已排队或在途的发言资格，材料、工具回执和旧记忆另按本域协议保存。 */
  private async cancelReplies(
    ownerId: string,
    conversationId: string,
    companionId: string | null,
    tx: DatabaseTransaction,
    now: Date,
  ): Promise<void> {
    const rows = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.ownerId, ownerId),
          eq(tasks.kind, 'chat_reply'),
          inArray(tasks.status, ['queued', 'running', 'waiting', 'paused', 'blocked']),
          sql`JSON_UNQUOTE(JSON_EXTRACT(${tasks.scope}, '$.conversationId')) = ${conversationId}`,
          companionId
            ? sql`JSON_UNQUOTE(JSON_EXTRACT(${tasks.scope}, '$.companionId')) = ${companionId}`
            : undefined,
        ),
      );
    for (const row of rows)
      await this.jobs.controlInTransaction(ownerId, tx, now, row.id, 'cancel');
    if (!companionId) await interruptGroupTurn(ownerId, conversationId, now, tx, this.jobs);
  }
}
