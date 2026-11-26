import { PeerService } from '../peer-talk/peer-service';
import { currentPeerPolicy, peerProfiles } from '../peer-talk/peer-policy';
import { Inject, Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import { and, eq, gt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import { autonomyOpportunities, contactIntents } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { ActivityService } from '../activities/activity-service';
import { assertVisible } from '../conversations/conversation-access';
import { ModelConfigurationService } from '../models/model-configuration.service';
import { modelInputReservation, ModelRuntimeService } from '../models/model-runtime.service';
import { TaskStore, taskDatabaseTime } from '../tasks/task-store';
import type { TaskLease } from '../tasks/task-types';
import { TasksService } from '../tasks/tasks.service';
import { AutonomyBudget } from './autonomy-budget';
import { latestUserMessage } from './autonomy-contacts';
import { autonomyChoiceSchema, autonomyDefinition } from './autonomy-definition';
import { currentAutonomyPolicy, requireAutonomyScope } from './autonomy-policy';

type Opportunity = typeof autonomyOpportunities.$inferSelect;

/** 同一次机会只使用同一输入，恢复不能悄悄选择新的交流内容。 */
export interface AutonomyPreparation {
  personaVersionId: string;
  source: { messageId: string; contentVersion: number } | null;
  inputText: string;
  allowedPeerIds?: string[];
}

/** 自主候选先判断保持安静，选择活动时才能创建实际执行任务。 */
@Injectable()
export class AutonomyExecution {
  /** 初始化探索运行和实际活动创建。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(TasksService) private readonly jobs: TasksService,
    @Inject(ModelConfigurationService) private readonly configuration: ModelConfigurationService,
    @Inject(ModelRuntimeService) private readonly models: ModelRuntimeService,
    @Inject(ActivityService) private readonly activities: ActivityService,
    @Inject(AutonomyBudget) private readonly budget: AutonomyBudget,
    @Inject(PeerService) private readonly peers: PeerService,
  ) {}

  /** 固定真实会话材料，完成后记录实际选择或联系意向。 */
  async execute(lease: TaskLease): Promise<void> {
    if (lease.input.kind !== 'autonomy') throw new TypeError('自主任务类型无效。');
    const ownerId = lease.ownerId;
    const config = await this.configuration.getVersion(ownerId, lease.input.configVersion);
    const initial = await this.store.locked(ownerId, async (tx) => {
      const checked = await this.guard(lease, tx);
      const { opportunity, policy, context, profile } = checked;
      let preparation = opportunity.preparation;
      if (!preparation) {
        const source = await latestUserMessage(
          ownerId,
          opportunity.conversationId,
          context.user.id,
          tx,
        );
        if (source?.sequence != null) await assertVisible(context.member, source.sequence, tx);
        // 探索采用初始兴趣和本会话确切原文。其他会话的成长证据不作为对外联系素材。
        const baseline = profile.document
          ? {
              name: profile.document.name,
              core: profile.document.core,
              inclinations: profile.document.inclinations,
              locks: profile.document.locks,
            }
          : { initialProfile: profile.profileText };
        const actor = await currentPeerPolicy(
          ownerId,
          opportunity.companionId,
          opportunity.runtimeEpoch,
          tx,
        );
        const profiles = actor?.enabled
          ? (await peerProfiles(ownerId, { limit: 6 }, tx)).items.filter(
              (entry) => entry.companionId !== opportunity.companionId,
            )
          : [];
        const inputText = JSON.stringify({
          persona: baseline,
          contactsAllowed: policy.contactsEnabled,
          ...(profiles.length ? { peers: profiles } : {}),
          lastUserText: source?.text.slice(0, 650).replace(/[\uD800-\uDBFF]$/u, '') ?? null,
        });
        preparation = {
          personaVersionId: profile.id,
          source: source ? { messageId: source.id, contentVersion: source.contentVersion } : null,
          inputText,
          allowedPeerIds: profiles.map((entry) => entry.companionId),
        };
        await this.update(
          opportunity,
          { preparation, sourceMessageId: preparation.source?.messageId ?? null },
          tx,
        );
      }
      return { opportunity, preparation };
    });
    const { opportunity, preparation } = initial;
    if (
      modelInputReservation(preparation.inputText, autonomyDefinition, 'structured') >
      config.config.tasks.reflection.maxInputTokens
    ) {
      await this.jobs.fail(lease, 'autonomy_input_budget');
      return;
    }
    let call;
    try {
      call = await this.models.execute(
        ownerId,
        {
          requestId: lease.task.id,
          expectedConfigVersion: config.version,
          role: 'reflection',
          operation: 'structured',
          lane: 'background',
          inputText: preparation.inputText,
        },
        autonomyDefinition,
        lease.task.scope,
        async (_, tx) => {
          await this.guard(lease, tx);
          await this.budget.model(ownerId, opportunity.companionId, lease.task.id, tx);
        },
      );
    } catch (error) {
      if (!(error instanceof ApiException) || error.code !== API_CODES.AUTONOMY_DAILY_LIMIT)
        throw error;
      await this.jobs.park(lease, 'autonomy_generation_budget', this.budget.nextDay(new Date()));
      return;
    }
    while (call.status === 'running') {
      await delay(lease.config.pollMs);
      await this.jobs.heartbeat(lease);
      call = await this.models.get(ownerId, call.id);
    }
    if (call.status === 'unknown') {
      await this.jobs.block(lease, 'model_result_unknown');
      return;
    }
    const parsed = autonomyChoiceSchema.safeParse(
      call.result?.kind === 'structured' ? call.result.value : null,
    );
    if (call.status !== 'succeeded' || !parsed.success) {
      await this.jobs.fail(lease, 'autonomy_model_failed');
      return;
    }
    await this.jobs.checkpoint(lease, {
      completedSteps: 1,
      stage: 'autonomy_decided',
      modelCallId: call.id,
    });
    await this.jobs.complete(lease, async (_, tx) => {
      const checked = await this.guard(lease, tx);
      const now = await taskDatabaseTime(this.database, ownerId, tx);
      const { choice, reason, text } = parsed.data;
      const common = { preparation: null, explanation: reason };
      const { companionId, conversationId, runtimeEpoch } = opportunity;
      const scope = { companionId, conversationId, runtimeEpoch };
      if (
        choice === 'write' &&
        text &&
        config.config.tasks.chat.enabled &&
        (config.config.tasks.chat.providerId === 'test' ? 'test' : 'model') === opportunity.mode
      ) {
        const activity = await this.activities.createAutonomous(
          ownerId,
          scope,
          {
            kind: 'write',
            goal: text,
            ...(preparation.source ? { source: preparation.source } : {}),
          },
          opportunity.id,
          config.version,
          checked.policy.version,
          tx,
          now,
        );
        await this.update(
          opportunity,
          { ...common, outcome: 'activity', activityId: activity.id },
          tx,
        );
        return;
      }
      if (
        choice === 'peer_invite' &&
        parsed.data.peerId &&
        preparation.allowedPeerIds?.includes(parsed.data.peerId)
      ) {
        const invitationId = await this.peers.invite(
          ownerId,
          checked.context.member,
          parsed.data.peerId,
          opportunity.id,
          tx,
          now,
        );
        if (invitationId) {
          await this.update(opportunity, { ...common, outcome: 'invitation', invitationId }, tx);
          return;
        }
      }
      if (choice === 'contact' && text && checked.policy.contactsEnabled) {
        const [pending] = await tx
          .select({ id: contactIntents.id })
          .from(contactIntents)
          .where(
            and(
              eq(contactIntents.ownerId, ownerId),
              eq(contactIntents.companionId, companionId),
              eq(contactIntents.runtimeEpoch, runtimeEpoch),
              eq(contactIntents.state, 'pending'),
              eq(contactIntents.policyVersion, checked.policy.version),
              gt(contactIntents.expiresAt, now),
            ),
          )
          .limit(1);
        if (!pending) {
          const contactId = randomUUID();
          await tx.insert(contactIntents).values({
            ...scope,
            ownerId,
            id: contactId,
            opportunityId: opportunity.id,
            policyVersion: checked.policy.version,
            state: 'pending',
            explanation: reason,
            text,
            sourceMessageId: preparation.source?.messageId,
            sourceContentVersion: preparation.source?.contentVersion,
            expiresAt: new Date(now.getTime() + this.budget.limits.contactExpiryMs),
            createdAt: now,
          });
          await this.update(opportunity, { ...common, outcome: 'contact', contactId }, tx);
          return;
        }
      }
      await this.update(
        opportunity,
        {
          ...common,
          outcome: 'quiet',
          reason:
            choice === 'quiet'
              ? null
              : choice === 'write'
                ? 'autonomy_activity_unavailable'
                : choice === 'peer_invite'
                  ? 'autonomy_peer_unavailable'
                  : 'autonomy_contact_deferred',
        },
        tx,
      );
    });
  }

  /** 运行授权、人格和实际资料在每次模型派发及采用前核对。 */
  private async guard(lease: TaskLease, tx: DatabaseTransaction) {
    const ownerId = lease.ownerId;
    await this.jobs.guardDispatch(ownerId, tx, lease);
    const [opportunity] = await tx
      .select()
      .from(autonomyOpportunities)
      .where(
        and(
          eq(autonomyOpportunities.ownerId, ownerId),
          eq(autonomyOpportunities.id, lease.task.id),
        ),
      )
      .limit(1);
    if (!opportunity || opportunity.outcome !== 'pending' || !this.budget.limits.enabled)
      throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
    const { companionId, runtimeEpoch, conversationId } = opportunity;
    if (
      companionId !== lease.task.scope.companionId ||
      conversationId !== lease.task.scope.conversationId ||
      runtimeEpoch !== lease.task.scope.runtimeEpoch
    )
      throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
    const policy = await currentAutonomyPolicy(ownerId, companionId, runtimeEpoch, tx);
    if (
      !policy?.enabled ||
      policy.version !== opportunity.policyVersion ||
      policy.conversationId !== conversationId
    )
      throw new ApiException(API_CODES.PERMISSION_VERSION_CONFLICT);
    const context = await requireAutonomyScope(this.database, policy, tx);
    const instance = await this.database.companions.findById(ownerId, companionId, tx);
    const profile = instance?.currentPersonaVersionId
      ? await this.database.personaVersions.findOne(
          ownerId,
          { where: { id: instance.currentPersonaVersionId, companionId, runtimeEpoch } },
          tx,
        )
      : null;
    if (!profile) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    if (opportunity.preparation) {
      if (profile.id !== opportunity.preparation.personaVersionId)
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      const actual = await latestUserMessage(ownerId, conversationId, context.user.id, tx);
      const expected = opportunity.preparation.source;
      if (
        (actual?.id ?? null) !== (expected?.messageId ?? null) ||
        (actual?.contentVersion ?? null) !== (expected?.contentVersion ?? null)
      )
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      if (actual?.sequence != null) await assertVisible(context.member, actual.sequence, tx);
    }
    return { opportunity, policy, context, profile };
  }

  /** 机会状态随业务事务更新，原始模型输入只在未完成期间保存。 */
  private async update(
    opportunity: Opportunity,
    set: Partial<
      Pick<
        Opportunity,
        | 'outcome'
        | 'reason'
        | 'explanation'
        | 'preparation'
        | 'sourceMessageId'
        | 'activityId'
        | 'contactId'
        | 'invitationId'
      >
    >,
    tx: DatabaseTransaction,
  ) {
    await tx
      .update(autonomyOpportunities)
      .set(set)
      .where(
        and(
          eq(autonomyOpportunities.ownerId, opportunity.ownerId),
          eq(autonomyOpportunities.id, opportunity.id),
        ),
      );
  }
}
