import { stageReflectionEvent } from '../reflections/reflection-events';
import { SERVER_CONFIG } from '../../config';
import type { ServerConfig } from '../../config';
import { relationshipConfigurationSchema } from './relationship-config';
import type { RelationshipConfiguration } from './relationship-config';
import { Inject, Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  conversationMembers,
  memoryBatches,
  messages,
  relationshipSources,
  relationshipStates,
  relationshipVersions,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { requireCompanionMember } from '../conversations/conversation-access';
import { requireMemoryBatch } from '../memories/memory-access';
import type { MemoryOutput } from '../memories/memory-definition';
import { ModelRuntimeService, modelInputReservation } from '../models/model-runtime.service';
import { fingerprint } from '../shared/http';
import { TaskStore, taskDatabaseTime } from '../tasks/task-store';
import type { TaskLease } from '../tasks/task-types';
import { TasksService } from '../tasks/tasks.service';
import { validateRelationship } from './relationship-candidate';
import type { RelationshipSource, ValidatedRelationship } from './relationship-candidate';
import { relationshipDefinition, relationshipOutputSchema } from './relationship-definition';

type Batch = typeof memoryBatches.$inferSelect;

/** 已采用且有关感受或互动的新线索才唤醒关系任务。 */
export async function scheduleRelationship(
  database: DatabaseService,
  ownerId: string,
  batch: Batch,
  output: MemoryOutput,
  tx: DatabaseTransaction,
): Promise<void> {
  const relevant = output.actions.some(
    ({ action, document, evidence }) =>
      action !== 'defer' &&
      document?.reality !== 'fictional' &&
      (document?.kind === 'relational' ||
        ['state', 'preference', 'interaction', 'commitment'].includes(document?.claim ?? '')) &&
      evidence.some((ref) => !ref.material),
  );
  if (!relevant) return;
  const config = await database.modelConfigurationVersions.findOne(
    ownerId,
    { where: { version: batch.configVersion } },
    tx,
  );
  if (!config?.config.tasks.relationship.enabled) return;
  const input = {
    kind: 'relationship_update' as const,
    batchId: batch.id,
    configVersion: config.version,
  };
  await database.tasks.insert(
    ownerId,
    {
      id: randomUUID(),
      requestKey: `relationship:${batch.id}`,
      fingerprint: fingerprint(input),
      kind: input.kind,
      input,
      scope: {
        companionId: batch.companionId,
        conversationId: batch.conversationId,
        runtimeEpoch: batch.runtimeEpoch,
      },
      totalSteps: 1,
    },
    tx,
  );
}

/** 候选验证、方向更新与任务成功在一个主库事务内提交。 */
@Injectable()
export class RelationshipExecution {
  private readonly limits: RelationshipConfiguration;
  /** 初始化关系状态更新任务。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(TasksService) private readonly jobs: TasksService,
    @Inject(ModelRuntimeService) private readonly models: ModelRuntimeService,
    @Inject(SERVER_CONFIG) config: ServerConfig,
  ) {
    this.limits = relationshipConfigurationSchema.parse(config.relationshipConfiguration ?? {});
  }

  /** 为实际对话线索提议状态变化，允许空结果。 */
  async execute(lease: TaskLease): Promise<void> {
    if (lease.input.kind !== 'relationship_update') throw new TypeError('关系任务类型无效。');
    const { batchId, configVersion } = lease.input;
    const ownerId = lease.ownerId;
    /** 重查租约和实际输入来源。 */
    const guard = async (_ownerId: string, tx: DatabaseTransaction) => {
      await this.jobs.guardDispatch(ownerId, tx, lease);
      const batch = await requireMemoryBatch(this.database, ownerId, batchId, tx);
      if (
        !batch.completedAt ||
        batch.companionId !== lease.task.scope.companionId ||
        batch.conversationId !== lease.task.scope.conversationId ||
        batch.runtimeEpoch !== lease.task.scope.runtimeEpoch
      )
        throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
      return batch;
    };
    const input = await this.store.locked(ownerId, async (tx) => {
      const batch = await guard(ownerId, tx);
      const config = await this.database.modelConfigurationVersions.findOne(
        ownerId,
        { where: { version: configVersion } },
        tx,
      );
      if (!config) throw new ApiException(API_CODES.VERSION_CONFLICT);
      const input = await this.prepare(ownerId, batch, tx);
      const maxInput = config.config.tasks.relationship.maxInputTokens;
      while (
        input.sources.length &&
        modelInputReservation(JSON.stringify(input), relationshipDefinition, 'structured') >
          maxInput
      ) {
        const prior = input.sources.findIndex((source) => !source.target);
        input.sources.splice(Math.max(prior, 0), 1);
      }
      return input;
    });
    if (!input.participants.length || !input.sources.some((source) => source.target)) {
      await this.jobs.checkpoint(lease, { completedSteps: 1, stage: 'relationship_no_input' });
      await this.jobs.complete(lease, async (_, tx) => {
        await guard(ownerId, tx);
      });
      return;
    }
    let call = await this.models.execute(
      ownerId,
      {
        requestId: lease.task.id,
        expectedConfigVersion: configVersion,
        role: 'relationship',
        operation: 'structured',
        lane: 'background',
        inputText: JSON.stringify(input),
      },
      relationshipDefinition,
      lease.task.scope,
      async (ownerId, tx) => {
        await guard(ownerId, tx);
      },
    );
    while (call.status === 'running') {
      await delay(lease.config.pollMs);
      await this.jobs.heartbeat(lease);
      call = await this.models.get(ownerId, call.id);
    }
    if (call.status === 'unknown') {
      await this.jobs.block(lease, 'model_result_unknown');
      return;
    }
    const output = relationshipOutputSchema.safeParse(
      call.result?.kind === 'structured' ? call.result.value : null,
    );
    if (call.status !== 'succeeded' || !output.success) {
      await this.jobs.fail(lease, 'relationship_model_failed');
      return;
    }
    const counterpartIds = new Set(input.participants.map((item) => item.id));
    const candidates = new Map<string, ValidatedRelationship>();
    for (const value of output.data.updates) {
      const candidate = validateRelationship(value, input.self, counterpartIds, input.sources);
      if (!candidate) continue;
      const key = `${candidate.counterpartMembershipId}:${candidate.kind}:${candidate.topic}`;
      const previous = candidates.get(key);
      if (!previous || previous.lastSequence < candidate.lastSequence)
        candidates.set(key, candidate);
    }
    await this.jobs.checkpoint(lease, {
      completedSteps: 1,
      stage: 'relationship_candidate',
      modelCallId: call.id,
    });
    await this.jobs.complete(lease, async (_, tx) => {
      const batch = await guard(ownerId, tx);
      const now = await taskDatabaseTime(this.database, ownerId, tx);
      for (const candidate of candidates.values()) {
        await this.adopt(
          batch,
          candidate,
          input.sources,
          lease.task.id,
          call.providerId === 'test' ? 'test' : 'model',
          tx,
          now,
        );
      }
    });
  }

  /** 只把已授权的交流原文和客观成员身份提供给模型。 */
  private async prepare(ownerId: string, batch: Batch, tx: DatabaseTransaction) {
    const self = await requireCompanionMember(
      this.database,
      ownerId,
      batch.companionId,
      batch.runtimeEpoch,
      batch.conversationId,
      tx,
    );
    if (self.deletedAt || self.leftSequence !== null)
      throw new ApiException(API_CODES.LIFECYCLE_RESTRICTED);
    const eligible = batch.input!.messages.filter(
      (source) =>
        source.reality !== 'fictional' && source.epistemic !== 'setting' && source.text.length > 0,
    );
    if (!eligible.length) return { self: self.id, participants: [], sources: [] };
    const rows = await tx
      .select({
        messageId: messages.id,
        speakerMembershipId: messages.speakerMembershipId,
        kind: conversationMembers.kind,
      })
      .from(messages)
      .innerJoin(
        conversationMembers,
        and(
          eq(conversationMembers.ownerId, ownerId),
          eq(conversationMembers.conversationId, batch.conversationId),
          eq(conversationMembers.id, messages.speakerMembershipId),
        ),
      )
      .where(
        and(
          eq(messages.ownerId, ownerId),
          eq(messages.conversationId, batch.conversationId),
          inArray(
            messages.id,
            eligible.map((item) => item.messageId),
          ),
        ),
      );
    const speakers = new Map(rows.map((row) => [row.messageId, row]));
    const parts = new Map<string, { id: string; kind: 'companion' | 'user' }>();
    const sources: RelationshipSource[] = [];
    for (const source of eligible) {
      const speaker = speakers.get(source.messageId);
      if (!speaker) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      if (speaker.speakerMembershipId !== self.id) {
        parts.set(speaker.speakerMembershipId, {
          id: speaker.speakerMembershipId,
          kind: speaker.kind,
        });
      }
      sources.push({
        messageId: source.messageId,
        contentVersion: source.contentVersion,
        sequence: source.sequence,
        text: source.text.slice(0, 640).replace(/[\uD800-\uDBFF]$/u, ''),
        target: source.target,
        publishedAt: source.publishedAt,
        epistemic: source.epistemic,
        speakerMembershipId: speaker.speakerMembershipId,
      });
    }
    return { self: self.id, participants: [...parts.values()], sources };
  }

  /** 保留每个方向和主题的版本，高水位防止相同事件重复累计。 */
  private async adopt(
    batch: Batch,
    candidate: ValidatedRelationship,
    sources: RelationshipSource[],
    taskId: string,
    mode: 'test' | 'model',
    tx: DatabaseTransaction,
    now: Date,
  ): Promise<void> {
    const { ownerId, companionId, runtimeEpoch, conversationId } = batch;
    const { kind, counterpartMembershipId, topic, document, evidence, lastSequence, observedAt } =
      candidate;
    const [state] = await tx
      .select()
      .from(relationshipStates)
      .where(
        and(
          eq(relationshipStates.ownerId, ownerId),
          eq(relationshipStates.companionId, companionId),
          eq(relationshipStates.runtimeEpoch, runtimeEpoch),
          eq(relationshipStates.conversationId, conversationId),
          eq(relationshipStates.counterpartMembershipId, counterpartMembershipId),
          eq(relationshipStates.kind, kind),
          eq(relationshipStates.topic, topic),
        ),
      )
      .limit(1);
    if (state && state.lastSequence >= lastSequence) return;
    const stateId = state?.id ?? randomUUID();
    const version = (state?.currentVersion ?? 0) + 1;
    if (version > 2_147_483_647) throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
    if (state)
      await tx
        .update(relationshipStates)
        .set({ currentVersion: version, lastSequence })
        .where(and(eq(relationshipStates.ownerId, ownerId), eq(relationshipStates.id, stateId)));
    else
      await tx.insert(relationshipStates).values({
        id: stateId,
        ownerId,
        companionId,
        runtimeEpoch,
        conversationId,
        counterpartMembershipId,
        kind,
        topic,
        currentVersion: version,
        lastSequence,
      });
    const duration =
      kind === 'self_emotion'
        ? this.limits.selfEmotionTtlMs
        : kind === 'observed_emotion'
          ? this.limits.observedEmotionTtlMs
          : null;
    const expiresAt = duration ? new Date(observedAt.getTime() + duration) : null;
    const id = randomUUID();
    await tx.insert(relationshipVersions).values({
      id,
      ownerId,
      stateId,
      version,
      taskId,
      document,
      evidence,
      mode,
      observedAt,
      expiresAt,
      createdAt: now,
    });
    if (kind === 'agreement' || kind === 'disagreement')
      await stageReflectionEvent(
        ownerId,
        batch,
        {
          kind: 'relationship',
          sourceId: stateId,
          sourceVersion: version,
          mode,
          priority: 1,
        },
        tx,
      );
    await tx.insert(relationshipSources).values(
      sources.map(({ messageId, contentVersion }) => ({
        ownerId,
        versionId: id,
        messageId,
        contentVersion,
      })),
    );
  }
}
