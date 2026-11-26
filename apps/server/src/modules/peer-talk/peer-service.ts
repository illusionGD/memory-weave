import { Inject, Injectable } from '@nestjs/common';
import { API_CODES, publishedMessageSchema } from '@memory-weave/contracts';
import type {
  IdPaginationQuery,
  ModelConfigurationVersion,
  PeerSessions,
} from '@memory-weave/contracts';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, notExists } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  conversationInvitations,
  groupTurnHeads,
  groupTurns,
  messages,
  peerRoomSettings,
  peerSessions,
  tasks,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { autonomyScopeUnavailable } from '../autonomy/autonomy-policy';
import { requireConversation, toMessage } from '../conversations/conversation-access';
import { ConversationInvitations } from '../conversations/conversation-invitations.service';
import { activeMemberships, requireOpenConversation } from '../conversations/membership-store';
import type { MemberRow } from '../conversations/membership-store';
import { GroupTurnsService } from '../group-turns/group-turns.service';
import { ModelConfigurationService } from '../models/model-configuration.service';
import { fingerprint } from '../shared/http';
import { TaskStore } from '../tasks/task-store';
import { PeerBudget } from './peer-budget';
import { currentPeerPolicy, currentPeerRoom } from './peer-policy';

type Room = typeof peerRoomSettings.$inferSelect;

/** 同伴发现、邀请决定和实际互聊只在明确授权的范围自动推进。 */
@Injectable()
export class PeerService {
  private nextScanAt = 0;
  private scanAfter: string | null = null;
  private invitationAfter: string | null = null;

  /** 初始化共享会话和付费调用的预算控制。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(ModelConfigurationService) private readonly config: ModelConfigurationService,
    @Inject(ConversationInvitations) private readonly invitations: ConversationInvitations,
    @Inject(GroupTurnsService) private readonly turns: GroupTurnsService,
    @Inject(PeerBudget) private readonly budget: PeerBudget,
  ) {}

  /** 在已有机会中向明确可发现的同伴提出邀请，不携带私聊文本。 */
  async invite(
    ownerId: string,
    sender: MemberRow,
    targetId: string,
    requestId: string,
    tx: DatabaseTransaction,
    now: Date,
  ) {
    if (
      !this.budget.limits.enabled ||
      !sender.companionId ||
      !sender.runtimeEpoch ||
      targetId === sender.companionId
    )
      return null;
    const permitted = await currentPeerPolicy(ownerId, sender.companionId, sender.runtimeEpoch, tx);
    const target = await this.database.companions.findById(ownerId, targetId, tx);
    const willing = target
      ? await currentPeerPolicy(ownerId, target.id, target.runtimeEpoch, tx)
      : null;
    if (
      !permitted?.enabled ||
      !target ||
      target.deletedAt ||
      target.lifecycleOperationId ||
      !willing?.enabled
    )
      return null;
    const room = await requireOpenConversation(ownerId, sender.conversationId, tx);
    try {
      const invitation = await this.invitations.createInTransaction(
        ownerId,
        sender.conversationId,
        {
          requestId,
          expectedConversationVersion: room.version,
          companionId: target.id,
          runtimeEpoch: target.runtimeEpoch,
          restoreRemoved: false,
          groupTitle: '同伴交流',
        },
        tx,
        now,
        sender.id,
      );
      return invitation.id;
    } catch (error) {
      if (
        error instanceof ApiException &&
        [API_CODES.CONFLICT, API_CODES.ACCESS_DENIED].some((code) => code === error.code)
      )
        return null;
      throw error;
    }
  }

  /** 定期处理未决伙伴邀请和有新话题的已启用会话。 */
  async wake(ownerId: string): Promise<void> {
    if (!this.budget.limits.enabled || Date.now() < this.nextScanAt) return;
    this.nextScanAt = Date.now() + 1000;
    const config = await this.config.get(ownerId);
    await this.store.locked(ownerId, async (tx, now) => {
      await this.decideInvitations(ownerId, tx, now);
      if (!config.config.tasks.chat.enabled) return;
      const newer = alias(peerRoomSettings, 'newer_peer_room');
      const rows = await tx
        .select()
        .from(peerRoomSettings)
        .where(
          and(
            eq(peerRoomSettings.ownerId, ownerId),
            eq(peerRoomSettings.enabled, true),
            this.scanAfter ? gt(peerRoomSettings.conversationId, this.scanAfter) : undefined,
            notExists(
              tx
                .select({ version: newer.version })
                .from(newer)
                .where(
                  and(
                    eq(newer.ownerId, ownerId),
                    eq(newer.conversationId, peerRoomSettings.conversationId),
                    gt(newer.version, peerRoomSettings.version),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(peerRoomSettings.conversationId))
        .limit(12);
      this.scanAfter = rows.length === 12 ? rows.at(-1)!.conversationId : null;
      for (const room of rows) {
        try {
          await this.schedule(room, config, tx, now);
        } catch (error) {
          if (!autonomyScopeUnavailable(error)) throw error;
        }
      }
    });
  }

  /** 查询本场合计调用、费用以及停止原因。 */
  sessions(
    ownerId: string,
    conversationId: string,
    query: IdPaginationQuery,
  ): Promise<PeerSessions> {
    return this.store.locked(ownerId, async (tx) => {
      await requireConversation(ownerId, conversationId, tx);
      const rows = await tx
        .select({ session: peerSessions, status: tasks.status, reason: tasks.reason })
        .from(peerSessions)
        .innerJoin(tasks, and(eq(tasks.ownerId, ownerId), eq(tasks.id, peerSessions.id)))
        .where(
          and(
            eq(peerSessions.ownerId, ownerId),
            eq(peerSessions.conversationId, conversationId),
            query.afterId ? gt(peerSessions.id, query.afterId) : undefined,
          ),
        )
        .orderBy(asc(peerSessions.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const items = [];
      for (const { session, status, reason } of page) {
        const used = await this.budget.usage(ownerId, session.id, tx);
        items.push({
          id: session.id,
          conversationId,
          triggerMessageId: session.triggerMessageId,
          ...used,
          maxCalls: session.maxCalls,
          maxOutputTokens: session.maxOutputTokens,
          reason:
            session.reason ??
            reason ??
            (status === 'succeeded' && used.calls >= session.maxCalls
              ? 'peer_session_limit'
              : null),
          createdAt: session.createdAt.toISOString(),
        });
      }
      return { items, nextAfterId: rows.length > query.limit ? page.at(-1)!.session.id : null };
    });
  }

  /** 仅处理伴侣邀请，采用被邀请实例明示的决定策略。 */
  private async decideInvitations(
    ownerId: string,
    tx: DatabaseTransaction,
    now: Date,
  ): Promise<void> {
    const pending = await tx
      .select()
      .from(conversationInvitations)
      .where(
        and(
          eq(conversationInvitations.ownerId, ownerId),
          isNotNull(conversationInvitations.requestedByMembershipId),
          this.invitationAfter ? gt(conversationInvitations.id, this.invitationAfter) : undefined,
          inArray(conversationInvitations.state, ['pending', 'deferred']),
          gt(conversationInvitations.expiresAt, now),
        ),
      )
      .orderBy(asc(conversationInvitations.id))
      .limit(12);
    this.invitationAfter = pending.length === 12 ? pending.at(-1)!.id : null;
    for (const item of pending) {
      const policy = await currentPeerPolicy(ownerId, item.companionId, item.runtimeEpoch, tx);
      if (!policy?.enabled || (policy.invitationDecision === 'defer' && item.state === 'deferred'))
        continue;
      try {
        const result = await this.invitations.decideInTransaction(
          ownerId,
          item.conversationId,
          item.id,
          {
            requestId: randomUUID(),
            expectedVersion: item.version,
            decision: policy.invitationDecision,
          },
          { kind: 'companion', companionId: item.companionId, runtimeEpoch: item.runtimeEpoch },
          tx,
          now,
        );
        const joined = result.acceptedConversationId;
        if (
          !joined ||
          joined === item.conversationId ||
          (await currentPeerRoom(ownerId, joined, tx))
        )
          continue;
        const eligible = await this.eligible(ownerId, joined, tx);
        if (eligible.length < 2) continue;
        await tx.insert(peerRoomSettings).values({
          ownerId,
          conversationId: joined,
          version: 1,
          enabled: true,
          allowExit: true,
          requestId: item.id,
          fingerprint: fingerprint({ invitationId: item.id }),
          createdAt: now,
        });
      } catch (error) {
        if (
          !autonomyScopeUnavailable(error) &&
          !(error instanceof ApiException && error.code === API_CODES.CONFLICT)
        )
          throw error;
      }
    }
  }

  /** 只从新的真实话题启动，每个真实触发只能形成一场。 */
  private async schedule(
    room: Room,
    config: ModelConfigurationVersion,
    tx: DatabaseTransaction,
    now: Date,
  ): Promise<void> {
    const { ownerId, conversationId } = room;
    await requireOpenConversation(ownerId, conversationId, tx);
    const [active] = await tx
      .select({ id: tasks.id })
      .from(groupTurnHeads)
      .innerJoin(
        tasks,
        and(
          eq(tasks.ownerId, ownerId),
          eq(tasks.id, groupTurnHeads.turnId),
          inArray(tasks.status, ['queued', 'running', 'waiting', 'paused']),
        ),
      )
      .where(
        and(eq(groupTurnHeads.ownerId, ownerId), eq(groupTurnHeads.conversationId, conversationId)),
      )
      .limit(1);
    if (active) return;
    const replay = await this.database.chatThreads.findOne(
      ownerId,
      { where: { conversationId } },
      tx,
    );
    if (replay) return;
    const trigger = await this.database.messages.findOne(
      ownerId,
      {
        where: and(
          eq(messages.conversationId, conversationId),
          eq(messages.state, 'published'),
          isNull(messages.deletedAt),
          inArray(messages.sourceKind, ['user_input', 'admin_companion_input']),
        ),
        orderBy: [desc(messages.sequence)],
      },
      tx,
    );
    if (!trigger?.sequence || !trigger.text.trim()) return;
    const [used] = await tx
      .select({ id: groupTurns.id })
      .from(groupTurns)
      .where(and(eq(groupTurns.ownerId, ownerId), eq(groupTurns.triggerMessageId, trigger.id)))
      .limit(1);
    if (used) return;
    const members = await this.eligible(ownerId, conversationId, tx);
    if (members.length < 2) return;
    const topicFingerprint = fingerprint({
      text: trigger.text.normalize('NFKC').trim().replace(/\s+/g, ' '),
      participants: members.map((member) => member.companionId).sort(),
    });
    const [same] = await tx
      .select({ id: peerSessions.id })
      .from(peerSessions)
      .where(
        and(
          eq(peerSessions.ownerId, ownerId),
          eq(peerSessions.topicFingerprint, topicFingerprint),
          gte(peerSessions.createdAt, new Date(now.getTime() - this.budget.limits.topicCooldownMs)),
        ),
      )
      .limit(1);
    if (same) return;
    const last = members.findIndex((member) => member.id === trigger.speakerMembershipId);
    const selected = Array.from(
      { length: this.budget.limits.sessionCalls },
      (_, i) => members[(last + i + 1) % members.length]!,
    );
    const message = publishedMessageSchema.parse(
      await toMessage(ownerId, this.database, trigger, tx),
    );
    const created = await this.turns.enqueue(
      ownerId,
      message,
      selected,
      {
        requestId: randomUUID(),
        fingerprint: topicFingerprint,
        origin: 'autonomous',
        addressing: 'any',
        version: config.version,
        mode: config.config.tasks.chat.providerId === 'test' ? 'test' : 'model',
      },
      tx,
      now,
    );
    await tx.insert(peerSessions).values({
      ownerId,
      id: created.id,
      conversationId,
      triggerMessageId: trigger.id,
      topicFingerprint,
      roomVersion: room.version,
      maxCalls: this.budget.limits.sessionCalls,
      maxOutputTokens: this.budget.limits.outputTokens,
      maxCostMicros: this.budget.limits.sessionCostMicros,
      createdAt: now,
    });
  }

  /** 当前同伴许可和实际会话成员须同时有效。 */
  private async eligible(
    ownerId: string,
    id: string,
    tx: DatabaseTransaction,
  ): Promise<MemberRow[]> {
    const members = await activeMemberships(ownerId, id, tx);
    const selected = [];
    for (const member of members) {
      if (member.kind !== 'companion') continue;
      if (
        (await currentPeerPolicy(ownerId, member.companionId!, member.runtimeEpoch!, tx))?.enabled
      )
        selected.push(member);
    }
    return selected;
  }
}
