import { Inject, Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import type {
  IdPaginationQuery,
  Invitation,
  InvitationDecision,
  InvitationList,
  NewInvitation,
} from '@memory-weave/contracts';
import { and, asc, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  conversationInvitations,
  conversationMembers,
  visibilityGrants,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { fingerprint } from '../shared/http';
import { TaskStore } from '../tasks/task-store';
import { requireCompanion, requireConversation } from './conversation-access';
import { ConversationsService } from './conversations.service';
import {
  activeMemberships,
  advanceConversation,
  membership,
  replayMembershipCommand,
  requireOpenConversation,
  rewriteMembershipGrants,
  saveMembershipCommand,
} from './membership-store';
import type { ConversationRow } from './membership-store';

type Invite = typeof conversationInvitations.$inferSelect;
type Decider = { kind: 'owner' } | { kind: 'companion'; companionId: string; runtimeEpoch: number };
const INVITE_TTL_MS = 86400000;

/** 邀请与成员加入分别提交，私聊扩展只在新群里建立成员。 */
@Injectable()
export class ConversationInvitations {
  /** 初始化邀请管理与会话创建。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(ConversationsService) private readonly conversations: ConversationsService,
  ) {}

  /** 管理账号可向当前会话发出邀请。 */
  create(ownerId: string, conversationId: string, command: NewInvitation): Promise<Invitation> {
    return this.store.locked(ownerId, (tx, now) =>
      this.createInTransaction(ownerId, conversationId, command, tx, now),
    );
  }

  /** 伴侣邀请沿用相同作用域和用户限制，调用方负责证明实际行为来源。 */
  async createInTransaction(
    ownerId: string,
    conversationId: string,
    command: NewInvitation,
    tx: DatabaseTransaction,
    now: Date,
    requestedByMembershipId?: string,
  ): Promise<Invitation> {
    const requestId = command.requestId.toLowerCase();
    const companionId = command.companionId.toLowerCase();
    const hash = fingerprint({
      ...command,
      requestId,
      companionId,
      conversationId,
      requestedByMembershipId,
    });
    await requireConversation(ownerId, conversationId, tx);
    const [replay] = await tx
      .select()
      .from(conversationInvitations)
      .where(
        and(
          eq(conversationInvitations.ownerId, ownerId),
          eq(conversationInvitations.requestId, requestId),
        ),
      )
      .limit(1);
    if (replay) {
      if (replay.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
      return invitationView(replay, now);
    }
    const conversation = await requireOpenConversation(ownerId, conversationId, tx);
    if (conversation.version !== command.expectedConversationVersion)
      throw new ApiException(API_CODES.VERSION_CONFLICT);
    await requireCompanion(this.database, ownerId, companionId, command.runtimeEpoch, tx);
    if (requestedByMembershipId) {
      const sender = await membership(ownerId, conversationId, requestedByMembershipId, tx);
      if (
        !conversation.peerInvitationsEnabled ||
        sender.kind !== 'companion' ||
        sender.leftSequence !== null ||
        command.restoreRemoved
      )
        throw new ApiException(API_CODES.ACCESS_DENIED);
      await requireCompanion(this.database, ownerId, sender.companionId!, sender.runtimeEpoch!, tx);
    }
    const members = await activeMemberships(ownerId, conversationId, tx);
    if (members.some((sender) => sender.companionId === companionId) || members.length >= 20)
      throw new ApiException(API_CODES.CONFLICT);
    await this.requireAllowed(ownerId, conversationId, companionId, command.restoreRemoved, tx);
    const [existing] = await tx
      .select({ id: conversationInvitations.id })
      .from(conversationInvitations)
      .where(
        and(
          eq(conversationInvitations.ownerId, ownerId),
          eq(conversationInvitations.conversationId, conversationId),
          eq(conversationInvitations.companionId, companionId),
          eq(conversationInvitations.runtimeEpoch, command.runtimeEpoch),
          inArray(conversationInvitations.state, ['pending', 'deferred']),
          gt(conversationInvitations.expiresAt, now),
        ),
      )
      .limit(1);
    if (existing) throw new ApiException(API_CODES.CONFLICT, '此伴侣已有有效邀请。');
    const id = randomUUID();
    await tx.insert(conversationInvitations).values({
      id,
      ownerId,
      conversationId,
      companionId,
      runtimeEpoch: command.runtimeEpoch,
      requestedByMembershipId,
      requestId,
      fingerprint: hash,
      groupTitle: command.groupTitle,
      restoreRemoved: command.restoreRemoved,
      state: 'pending',
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
      createdAt: now,
    });
    return invitationView(await this.row(ownerId, conversationId, id, tx), now);
  }

  /** 管理账号记录明确的邀请决定。 */
  decide(
    ownerId: string,
    conversationId: string,
    id: string,
    command: InvitationDecision,
  ): Promise<Invitation> {
    return this.store.locked(ownerId, (tx, now) =>
      this.decideInTransaction(ownerId, conversationId, id, command, { kind: 'owner' }, tx, now),
    );
  }

  /** 记录受邀者的决定，接受时将新权限与成员加入原子提交。 */
  async decideInTransaction(
    ownerId: string,
    conversationId: string,
    id: string,
    command: InvitationDecision,
    decider: Decider,
    tx: DatabaseTransaction,
    now: Date,
  ): Promise<Invitation> {
    await requireConversation(ownerId, conversationId, tx);
    const requestId = command.requestId.toLowerCase();
    const hash = fingerprint({
      ...command,
      requestId,
      invitationId: id,
      decider,
      action: 'invitation_decision',
    });
    const replay = await replayMembershipCommand<Invitation>(
      ownerId,
      conversationId,
      requestId,
      hash,
      tx,
    );
    if (replay) return replay;
    const current = await this.row(ownerId, conversationId, id, tx);
    if (
      decider.kind === 'companion' &&
      (decider.companionId !== current.companionId ||
        decider.runtimeEpoch !== current.runtimeEpoch ||
        command.decision === 'cancel')
    )
      throw new ApiException(API_CODES.ACCESS_DENIED);
    if (command.expectedVersion !== current.version)
      throw new ApiException(API_CODES.VERSION_CONFLICT);
    if (!['pending', 'deferred'].includes(invitationView(current, now).state))
      throw new ApiException(API_CODES.CONFLICT, '邀请已经结束。');
    let acceptedConversationId: string | null = null;
    const states = {
      accept: 'accepted',
      decline: 'declined',
      defer: 'deferred',
      cancel: 'cancelled',
    } as const;
    if (command.decision === 'accept') {
      const conversation = await requireOpenConversation(ownerId, conversationId, tx);
      await requireCompanion(this.database, ownerId, current.companionId, current.runtimeEpoch, tx);
      await this.requireAllowed(
        ownerId,
        conversationId,
        current.companionId,
        current.restoreRemoved,
        tx,
      );
      if (current.requestedByMembershipId) {
        const sender = await membership(
          ownerId,
          conversationId,
          current.requestedByMembershipId,
          tx,
        );
        if (!conversation.peerInvitationsEnabled || sender.leftSequence !== null)
          throw new ApiException(API_CODES.ACCESS_DENIED);
        await requireCompanion(
          this.database,
          ownerId,
          sender.companionId!,
          sender.runtimeEpoch!,
          tx,
        );
      }
      acceptedConversationId = await this.admit(current, conversation, tx);
    }
    if (current.version >= 2_147_483_647) throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
    const change = {
      state: states[command.decision],
      version: current.version + 1,
      acceptedConversationId,
      decidedBy: decider.kind,
    };
    await tx
      .update(conversationInvitations)
      .set(change)
      .where(and(eq(conversationInvitations.ownerId, ownerId), eq(conversationInvitations.id, id)));
    return saveMembershipCommand(
      ownerId,
      conversationId,
      requestId,
      hash,
      invitationView({ ...current, ...change }, now),
      now,
      tx,
    );
  }

  /** 查询邀请，并在读视图中反映超出有效期的邀请。 */
  list(ownerId: string, conversationId: string, query: IdPaginationQuery): Promise<InvitationList> {
    return this.store.locked(ownerId, async (tx, now) => {
      await requireConversation(ownerId, conversationId, tx);
      const rows = await tx
        .select()
        .from(conversationInvitations)
        .where(
          and(
            eq(conversationInvitations.ownerId, ownerId),
            eq(conversationInvitations.conversationId, conversationId),
            query.afterId ? gt(conversationInvitations.id, query.afterId) : undefined,
          ),
        )
        .orderBy(asc(conversationInvitations.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((row) => invitationView(row, now)),
        nextAfterId: rows.length > query.limit ? page.at(-1)!.id : null,
      };
    });
  }

  /** 保持私聊原权限，在当前群聊以精确的发布边界加入或重新加入。 */
  private async admit(
    invite: Invite,
    conversation: ConversationRow,
    tx: DatabaseTransaction,
  ): Promise<string> {
    const { ownerId, conversationId, companionId, runtimeEpoch } = invite;
    const members = await activeMemberships(ownerId, conversationId, tx);
    if (members.length >= 20 || members.some((row) => row.companionId === companionId))
      throw new ApiException(API_CODES.CONFLICT);
    if (conversation.kind === 'private') {
      if (members.length !== 2) throw new ApiException(API_CODES.CONFLICT);
      const group = await this.conversations.createInTransaction(ownerId, tx, {
        requestId: randomUUID(),
        kind: 'group',
        title: invite.groupTitle ?? '新群聊',
        includeUser: members.some((row) => row.kind === 'user'),
        companions: [
          ...members
            .filter((row) => row.kind === 'companion')
            .map((row) => ({ companionId: row.companionId!, runtimeEpoch: row.runtimeEpoch! })),
          { companionId, runtimeEpoch },
        ],
      });
      return group.conversation.id;
    }
    if (conversation.lastSequence >= 2_147_483_647)
      throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
    const joinedSequence = conversation.lastSequence + 1;
    const [previous] = await tx
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.ownerId, ownerId),
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.companionId, companionId),
          eq(conversationMembers.runtimeEpoch, runtimeEpoch),
          isNull(conversationMembers.deletedAt),
        ),
      )
      .limit(1);
    if (invite.restoreRemoved)
      await tx
        .update(conversationMembers)
        .set({ removedAt: null })
        .where(
          and(
            eq(conversationMembers.ownerId, ownerId),
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.companionId, companionId),
            isNotNull(conversationMembers.removedAt),
          ),
        );
    if (previous) {
      await rewriteMembershipGrants(
        previous,
        { joinedSequence, leftSequence: null, removedAt: null },
        tx,
      );
    } else {
      const id = randomUUID();
      await tx.insert(conversationMembers).values({
        id,
        ownerId,
        conversationId,
        companionId,
        runtimeEpoch,
        kind: 'companion',
        joinedSequence,
      });
      await tx.insert(visibilityGrants).values({
        ownerId,
        membershipId: id,
        startSequence: joinedSequence,
        kind: 'membership',
        permissionVersion: 1,
      });
    }
    await advanceConversation(conversation, tx);
    return conversationId;
  }

  /** 用户移除权限不被伴侣邀请覆盖，管理员需作明确恢复操作。 */
  private async requireAllowed(
    ownerId: string,
    conversationId: string,
    companionId: string,
    restore: boolean,
    tx: DatabaseTransaction,
  ): Promise<void> {
    const [removed] = await tx
      .select({ id: conversationMembers.id })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.ownerId, ownerId),
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.companionId, companionId),
          isNotNull(conversationMembers.removedAt),
        ),
      )
      .limit(1);
    if (removed && !restore) throw new ApiException(API_CODES.ACCESS_DENIED);
  }

  /** 查询准确会话中的邀请。 */
  private async row(
    ownerId: string,
    conversationId: string,
    id: string,
    tx: DatabaseTransaction,
  ): Promise<Invite> {
    const [row] = await tx
      .select()
      .from(conversationInvitations)
      .where(
        and(
          eq(conversationInvitations.ownerId, ownerId),
          eq(conversationInvitations.conversationId, conversationId),
          eq(conversationInvitations.id, id),
        ),
      )
      .limit(1);
    if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    return row;
  }
}

/** 将已过期的未决邀请映射到终止视图。 */
function invitationView(row: Invite, now: Date): Invitation {
  const expired = ['pending', 'deferred'].includes(row.state) && row.expiresAt <= now;
  return {
    id: row.id,
    conversationId: row.conversationId,
    companionId: row.companionId,
    runtimeEpoch: row.runtimeEpoch,
    requestedByMembershipId: row.requestedByMembershipId,
    acceptedConversationId: row.acceptedConversationId,
    decidedBy: row.decidedBy,
    state: expired ? 'expired' : row.state,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}
