import { PeerBudget } from '../peer-talk/peer-budget';
import type { Session } from '../peer-talk/peer-budget';
import { currentPeerPolicy, currentPeerRoom } from '../peer-talk/peer-policy';
import { ConversationMembership } from '../conversations/conversation-membership.service';
import { membership } from '../conversations/membership-store';
import { Inject, Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import type { ModelCall } from '@memory-weave/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  groupTurnHeads,
  groupTurnSteps,
  groupTurns,
  messages,
  messageSources,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { ConversationsService } from '../conversations/conversations.service';
import { requireOpenConversation } from '../conversations/membership-store';
import { ModelConfigurationService } from '../models/model-configuration.service';
import { ModelRuntimeService } from '../models/model-runtime.service';
import { TaskStore, taskDatabaseTime } from '../tasks/task-store';
import type { TaskLease } from '../tasks/task-types';
import { TasksService } from '../tasks/tasks.service';
import { prepareGroupStep, validGroupStep } from './group-turn-context';
import type { GroupPreparation } from './group-turn-context';
import {
  groupReplySchema,
  groupTurnDefinition,
  peerReplySchema,
  peerTurnDefinition,
} from './group-turn-definition';

/** 每次只推进一个实际参与者，检查点和消息发布保持原子。 */
@Injectable()
export class GroupTurnExecution {
  /** 初始化按会话顺序推进的发言任务。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(TasksService) private readonly jobs: TasksService,
    @Inject(ConversationsService) private readonly originals: ConversationsService,
    @Inject(ModelConfigurationService) private readonly configuration: ModelConfigurationService,
    @Inject(ModelRuntimeService) private readonly models: ModelRuntimeService,
    @Inject(PeerBudget) private readonly peers: PeerBudget,
    @Inject(ConversationMembership) private readonly memberships: ConversationMembership,
  ) {}

  /** 恢复到尚未确认的参与者，已发布发言不重复生成。 */
  async execute(lease: TaskLease): Promise<void> {
    if (lease.input.kind !== 'group_turn') throw new TypeError('接话任务类型无效。');
    const ownerId = lease.ownerId;
    const config = await this.configuration.getVersion(ownerId, lease.input.configVersion);
    for (
      let ordinal = lease.task.progress.completedSteps + 1;
      ordinal <= lease.task.progress.totalSteps!;
      ordinal++
    ) {
      const prepared = await this.store.locked(ownerId, async (tx) => {
        const turn = await this.guard(lease, tx);
        const step = await this.step(ownerId, turn.id, ordinal, tx);
        const session =
          turn.origin === 'autonomous' ? await this.peers.session(ownerId, turn.id, tx) : undefined;
        const allowed =
          turn.origin === 'user' ||
          (session && (await this.peers.allowed(session, step.companionId, step.runtimeEpoch, tx)));
        const definition = session
          ? peerTurnDefinition(session.maxOutputTokens)
          : groupTurnDefinition;
        const context = allowed
          ? (step.preparation ??
            (await prepareGroupStep(this.database, turn, step, config, definition, tx)))
          : null;
        if (context && !step.preparation)
          await this.updateStep(ownerId, turn.id, ordinal, { preparation: context }, tx);
        return { turn, step, context, session, definition };
      });
      const { turn, step, context, session, definition } = prepared;
      if (!context || !(await this.valid(lease, turn, step, context))) {
        await this.settle(lease, ordinal, null, null);
        continue;
      }
      const digest = createHash('sha256')
        .update(`group-reply-v1:${turn.id}:${ordinal}`)
        .digest('hex');
      const requestId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      let call: ModelCall;
      try {
        call = await this.models.execute(
          ownerId,
          {
            requestId,
            expectedConfigVersion: config.version,
            role: 'chat',
            operation: 'structured',
            lane: turn.origin === 'user' ? 'interactive' : 'background',
            inputText: context.inputText,
          },
          definition,
          {
            conversationId: turn.conversationId,
            companionId: step.companionId,
            runtimeEpoch: step.runtimeEpoch,
          },
          async (_, tx) => {
            await this.guard(lease, tx);
            if (!(await validGroupStep(this.database, turn, step, context, tx)))
              throw new ApiException(API_CODES.PERMISSION_VERSION_CONFLICT);
            if (session)
              await this.peers.dispatch(
                session,
                step.companionId,
                step.runtimeEpoch,
                requestId,
                tx,
              );
          },
        );
      } catch (error) {
        if (
          session &&
          error instanceof ApiException &&
          (await this.knownBudgetStop(lease, session, error.code))
        ) {
          await this.settle(lease, ordinal, null, null);
          continue;
        }
        if (await this.valid(lease, turn, step, context)) throw error;
        await this.settle(lease, ordinal, null, null);
        continue;
      }
      while (call.status === 'running') {
        await delay(lease.config.pollMs);
        await this.jobs.heartbeat(lease);
        call = await this.models.get(ownerId, call.id);
      }
      if (!(await this.valid(lease, turn, step, context))) {
        await this.settle(lease, ordinal, null, call.id);
        continue;
      }
      if (
        session &&
        call.errorCode &&
        (await this.knownBudgetStop(lease, session, call.errorCode))
      ) {
        await this.settle(lease, ordinal, null, call.id);
        continue;
      }
      if (call.status === 'unknown') {
        await this.jobs.block(lease, 'model_result_unknown');
        return;
      }
      const value = call.result?.kind === 'structured' ? call.result.value : null;
      const autonomousReply = session ? peerReplySchema.safeParse(value) : null;
      const result = autonomousReply ?? groupReplySchema.safeParse(value);
      if (call.status !== 'succeeded' || !result.success) {
        await this.jobs.fail(lease, 'group_reply_failed');
        return;
      }
      const leaveEvidence = autonomousReply?.success
        ? autonomousReply.data.evidenceMessageIds
        : undefined;
      await this.settle(
        lease,
        ordinal,
        { context, text: result.data.text, requestId, session, leaveEvidence },
        call.id,
      );
    }
    await this.jobs.complete(lease, async (_, tx) => {
      await this.guard(lease, tx);
    });
  }

  /** 核对会话当前指针和触发消息，拒绝插话和生命周期限制后的旧结果。 */
  private async guard(lease: TaskLease, tx: DatabaseTransaction) {
    const ownerId = lease.ownerId;
    await this.jobs.guardDispatch(ownerId, tx, lease);
    const id = lease.task.scope.conversationId!;
    await requireOpenConversation(ownerId, id, tx);
    const [turn] = await tx
      .select({ row: groupTurns })
      .from(groupTurnHeads)
      .innerJoin(
        groupTurns,
        and(eq(groupTurns.ownerId, ownerId), eq(groupTurns.id, groupTurnHeads.turnId)),
      )
      .where(and(eq(groupTurnHeads.ownerId, ownerId), eq(groupTurnHeads.conversationId, id)))
      .limit(1);
    if (!turn || turn.row.id !== lease.task.id || turn.row.interruptedAt)
      throw new ApiException(API_CODES.TASK_LEASE_LOST);
    const trigger = await this.database.messages.findOne(
      ownerId,
      {
        where: {
          id: turn.row.triggerMessageId,
          conversationId: id,
          contentVersion: turn.row.triggerContentVersion,
          state: 'published',
          deletedAt: null,
        },
      },
      tx,
    );
    if (trigger?.sequence !== turn.row.triggerSequence)
      throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    return turn.row;
  }

  /** 检查在模型等待中改变的成员或权限。 */
  private valid(
    lease: TaskLease,
    turn: typeof groupTurns.$inferSelect,
    step: typeof groupTurnSteps.$inferSelect,
    context: GroupPreparation,
  ): Promise<boolean> {
    return this.store.locked(lease.ownerId, async (tx) => {
      await this.guard(lease, tx);
      if (turn.origin === 'autonomous') {
        const session = await this.peers.session(lease.ownerId, turn.id, tx);
        if (
          !session ||
          !(await this.peers.allowed(session, step.companionId, step.runtimeEpoch, tx))
        )
          return false;
      }
      return validGroupStep(this.database, turn, step, context, tx);
    });
  }

  /** 单步骤的合法候选才发布，静默和失效各保存独立状态。 */
  private async settle(
    lease: TaskLease,
    ordinal: number,
    result: {
      context: GroupPreparation;
      text: string | null;
      requestId: string;
      session?: Session;
      leaveEvidence?: string[];
    } | null,
    modelCallId: string | null,
  ): Promise<void> {
    const ownerId = lease.ownerId;
    await this.jobs.checkpoint(
      lease,
      {
        completedSteps: ordinal,
        stage: 'group_reply',
        ...(modelCallId ? { modelCallId } : {}),
      },
      async (_, tx) => {
        const turn = await this.guard(lease, tx);
        const step = await this.step(ownerId, turn.id, ordinal, tx);
        const now = await taskDatabaseTime(this.database, ownerId, tx);
        let status: 'silent' | 'spoken' | 'skipped' | 'left' = 'skipped';
        let publishedMessageId: string | null = null;
        const peer = result?.session ? await this.peers.session(ownerId, turn.id, tx) : undefined;
        const allowed =
          turn.origin === 'user' ||
          (peer && (await this.peers.allowed(peer, step.companionId, step.runtimeEpoch, tx)));
        if (
          result &&
          allowed &&
          (await validGroupStep(this.database, turn, step, result.context, tx))
        ) {
          status = 'silent';
          if (peer && result.leaveEvidence) {
            status = (await this.exitWithEvidence(peer, step, result, tx, now))
              ? 'left'
              : 'skipped';
          } else if (peer && result.text === null) {
            await this.peers.reason(ownerId, turn.id, 'peer_quiet', tx);
          }
          if (result.text !== null) {
            const conversation = await requireOpenConversation(ownerId, turn.conversationId, tx);
            const draft = await this.originals.saveInTransaction(
              ownerId,
              tx,
              turn.conversationId,
              {
                requestId: result.requestId,
                expectedConversationVersion: conversation.version,
                speaker: {
                  kind: 'companion',
                  companionId: step.companionId,
                  runtimeEpoch: step.runtimeEpoch,
                },
                text: result.text,
                epistemicKind: 'statement',
                reality: 'unspecified',
                replyToMessageId: turn.triggerMessageId,
                sources: result.context.messages.map((source) => ({
                  ...source,
                  relation: 'reference' as const,
                })),
              },
              true,
            );
            const published = await this.originals.publishInTransaction(
              ownerId,
              tx,
              turn.conversationId,
              draft.id,
              {
                requestId: result.requestId,
                expectedConversationVersion: conversation.version,
                expectedRevision: draft.revision,
              },
            );
            // 人格倾向的跨会话来源只用于撤回派生记录，不能授予其他成员读原文权限。
            if (result.context.growthSources.length)
              await tx
                .insert(messageSources)
                .values(
                  result.context.growthSources.map((source) => ({
                    ownerId,
                    messageId: published.id,
                    sourceMessageId: source.messageId,
                    sourceContentVersion: source.contentVersion,
                    relation: 'reference' as const,
                  })),
                )
                .onDuplicateKeyUpdate({ set: { relation: 'reference' } });
            publishedMessageId = published.id;
            status = 'spoken';
          }
        }
        await this.updateStep(
          ownerId,
          turn.id,
          ordinal,
          {
            status,
            modelCallId,
            publishedMessageId,
            completedAt: now,
            preparation: null,
          },
          tx,
        );
      },
    );
  }

  /** 区分本场结束和单个实例额度用尽，预算变化从不改变成员。 */
  private async knownBudgetStop(
    lease: TaskLease,
    session: Session,
    code: number,
  ): Promise<boolean> {
    if (code === API_CODES.AUTONOMY_DAILY_LIMIT) return true;
    if (code !== API_CODES.PEER_SESSION_LIMIT) return false;
    await this.store.locked(lease.ownerId, async (tx) => {
      await this.guard(lease, tx);
      await this.peers.reason(lease.ownerId, session.id, 'peer_session_limit', tx);
    });
    return true;
  }

  /** 只有已实际参与且有独立来源的明确退出意向才影响群聊成员。 */
  private async exitWithEvidence(
    session: Session,
    step: typeof groupTurnSteps.$inferSelect,
    result: { context: GroupPreparation; requestId: string; leaveEvidence?: string[] },
    tx: DatabaseTransaction,
    now: Date,
  ): Promise<boolean> {
    const { ownerId, conversationId } = session;
    const scope = await requireOpenConversation(ownerId, conversationId, tx);
    const room = await currentPeerRoom(ownerId, conversationId, tx);
    const policy = await currentPeerPolicy(ownerId, step.companionId, step.runtimeEpoch, tx);
    if (scope.kind !== 'group' || !room?.allowExit || !policy?.allowExit) return false;
    const ids = [...new Set(result.leaveEvidence)];
    if (
      ids.length < 2 ||
      !ids.every((id) => result.context.messages.some((source) => source.messageId === id))
    )
      return false;
    const evidence = await tx
      .select({ speaker: messages.speakerMembershipId })
      .from(messages)
      .where(
        and(
          eq(messages.ownerId, ownerId),
          eq(messages.conversationId, conversationId),
          inArray(messages.id, ids),
        ),
      );
    if (
      evidence.length !== ids.length ||
      !evidence.some((row) => row.speaker === step.membershipId)
    )
      return false;
    const member = await membership(ownerId, conversationId, step.membershipId, tx);
    await this.memberships.exitInTransaction(
      ownerId,
      conversationId,
      step.membershipId,
      {
        requestId: result.requestId,
        expectedConversationVersion: scope.version,
        expectedPermissionVersion: member.permissionVersion,
      },
      'companion',
      tx,
      now,
    );
    return true;
  }

  /** 读取待推进的第几个参与者。 */
  private async step(ownerId: string, id: string, ordinal: number, tx: DatabaseTransaction) {
    const [row] = await tx
      .select()
      .from(groupTurnSteps)
      .where(
        and(
          eq(groupTurnSteps.ownerId, ownerId),
          eq(groupTurnSteps.turnId, id),
          eq(groupTurnSteps.ordinal, ordinal),
        ),
      )
      .limit(1);
    if (!row || row.status !== 'pending') throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
    return row;
  }

  /** 在持有有效租约时保存步骤检查点。 */
  private async updateStep(
    ownerId: string,
    id: string,
    ordinal: number,
    set: Partial<
      Pick<
        typeof groupTurnSteps.$inferInsert,
        'status' | 'modelCallId' | 'publishedMessageId' | 'completedAt' | 'preparation'
      >
    >,
    tx: DatabaseTransaction,
  ): Promise<void> {
    await tx
      .update(groupTurnSteps)
      .set(set)
      .where(
        and(
          eq(groupTurnSteps.ownerId, ownerId),
          eq(groupTurnSteps.turnId, id),
          eq(groupTurnSteps.ordinal, ordinal),
        ),
      );
  }
}
