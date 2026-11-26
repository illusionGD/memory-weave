import { Inject, Injectable } from '@nestjs/common';
import { API_CODES, personaDocumentSchema } from '@memory-weave/contracts';
import type { GrowthProposal, GrowthTrait, GrowthValidationResult } from '@memory-weave/contracts';
import { and, asc, eq, gte, inArray, isNull, ne } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SERVER_CONFIG } from '../../config';
import type { ServerConfig } from '../../config';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  growthCandidates,
  reflectionEvents,
  reflectionRunEvents,
  reflectionRuns,
  tasks,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { requireCompanion, requireCompanionMember } from '../conversations/conversation-access';
import { ModelRuntimeService } from '../models/model-runtime.service';
import type { ModelTaskDefinition } from '../models/model-task';
import { accessError } from '../reflections/reflection-planning';
import { materializeReflectionEvent } from '../reflections/reflection-input';
import type { MaterializedEvent } from '../reflections/reflection-input';
import { fingerprint } from '../shared/http';
import { TaskStore, taskDatabaseTime } from '../tasks/task-store';
import type { TaskLease } from '../tasks/task-types';
import { TasksService } from '../tasks/tasks.service';
import { growthConfigurationSchema } from './growth-config';
import type { GrowthConfiguration } from './growth-config';
import {
  growthDefinition,
  growthOutputSchema,
  growthValidationDefinition,
} from './growth-definition';
import { growthValidationResultSchema } from '@memory-weave/contracts';
import { activeGrowth, appendGrowthPersona } from './growth-persona';
import { currentGrowthControl } from './growth-service';

type Run = typeof reflectionRuns.$inferSelect;
type Candidate = typeof growthCandidates.$inferSelect;

/** 由实际反思唤醒局部提案和独立验证，只有两个步骤都符合时才自动写入。 */
@Injectable()
export class GrowthExecution {
  private readonly limits: GrowthConfiguration;

  /** 初始化成长执行和部署节奏。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(TasksService) private readonly jobs: TasksService,
    @Inject(ModelRuntimeService) private readonly models: ModelRuntimeService,
    @Inject(SERVER_CONFIG) config: ServerConfig,
  ) {
    this.limits = growthConfigurationSchema.parse(config.growthConfiguration ?? {});
  }

  /** 在反思提交事务内登记精确输入版本，较弱依据不会触发额外付费调用。 */
  async schedule(
    run: Run,
    configVersion: number,
    tx: DatabaseTransaction,
    now: Date,
  ): Promise<void> {
    if (!this.limits.enabled) return;
    const { ownerId, companionId, runtimeEpoch, conversationId, mode } = run;
    const config = await this.database.modelConfigurationVersions.findOne(
      ownerId,
      { where: { version: configVersion } },
      tx,
    );
    const modules = config?.config.tasks;
    if (
      !modules ||
      ![modules.growth, modules.growth_validation].every(
        (entry) => entry.enabled && (entry.providerId === 'test' ? 'test' : 'model') === mode,
      )
    )
      return;
    const control = await currentGrowthControl(ownerId, companionId, runtimeEpoch, tx);
    if (control.frozen || !(await this.withinPace(ownerId, companionId, now, tx))) return;
    const [active] = await tx
      .select({ id: growthCandidates.id })
      .from(growthCandidates)
      .innerJoin(
        tasks,
        and(
          eq(tasks.ownerId, ownerId),
          eq(tasks.id, growthCandidates.id),
          inArray(tasks.status, ['queued', 'running', 'waiting', 'paused']),
        ),
      )
      .where(
        and(
          eq(growthCandidates.ownerId, ownerId),
          eq(growthCandidates.companionId, companionId),
          eq(growthCandidates.runtimeEpoch, runtimeEpoch),
        ),
      )
      .limit(1);
    if (active) return;
    const assets = await this.assets(run, tx);
    if (independent(assets) < 2) return;
    const companion = await requireCompanion(this.database, ownerId, companionId, runtimeEpoch, tx);
    if (!companion.currentPersonaVersionId) return;
    const parent = await this.database.personaVersions.findOne(
      ownerId,
      {
        where: { companionId, runtimeEpoch, id: companion.currentPersonaVersionId },
      },
      tx,
    );
    if (!parent?.document) return;
    const id = randomUUID();
    const input = { kind: 'growth' as const, configVersion };
    await this.database.tasks.insert(
      ownerId,
      {
        id,
        kind: input.kind,
        input,
        requestKey: `growth:${run.id}`,
        fingerprint: fingerprint({ runId: run.id, parent: parent.id, configVersion }),
        scope: { companionId, runtimeEpoch, conversationId },
        totalSteps: 2,
        availableAt: now,
      },
      tx,
    );
    await tx.insert(growthCandidates).values({
      id,
      ownerId,
      companionId,
      runtimeEpoch,
      conversationId,
      sourceRunId: run.id,
      expectedPersonaVersionId: parent.id,
      expectedControlVersion: control.version,
      mode,
      status: 'queued',
      createdAt: now,
    });
  }

  /** 第一步完成后保存候选，第二步基于当前人格及原始依据追加验证。 */
  async execute(lease: TaskLease): Promise<void> {
    if (lease.input.kind !== 'growth') throw new TypeError('成长任务类型无效。');
    const configVersion = lease.input.configVersion;
    const ownerId = lease.ownerId;
    const initial = await this.store.locked(ownerId, async (tx) => {
      const checked = await this.guard(lease, tx);
      const assets = await this.assets(checked.run, tx);
      const { persona } = await activeGrowth(checked.parent, tx, checked.candidate.mode);
      return { ...checked, assets, persona };
    });
    const { candidate, run, assets, persona } = initial;
    if (independent(assets) < 2) {
      await this.jobs.block(lease, 'growth_evidence_missing');
      return;
    }
    const context = {
      currentPersona: personaDocumentSchema.parse(persona.document),
      reflection: run.result!.conclusion,
      evidence: assets.map(({ input }) => ({
        eventId: input.eventId,
        kind: input.kind,
        sourceId: input.sourceId,
        sourceVersion: input.sourceVersion,
        text: input.text,
        occurredAt: input.occurredAt,
        treatment: input.treatment,
      })),
    };
    let proposal = candidate.proposal
      ? growthOutputSchema.shape.proposal.parse(candidate.proposal)
      : null;
    if (!proposal) {
      const call = await this.call(
        lease,
        configVersion,
        'growth',
        lease.task.id,
        JSON.stringify(context),
        growthDefinition,
      );
      if (!call) return;
      const output = growthOutputSchema.safeParse(
        call.result?.kind === 'structured' ? call.result.value : null,
      );
      if (!output.success) throw new ApiException(API_CODES.MODEL_OUTPUT_INVALID);
      proposal = output.data.proposal;
      const valid = proposal && this.supports(proposal, run, assets);
      await this.jobs.checkpoint(
        lease,
        {
          completedSteps: 1,
          stage: 'growth_proposal',
          modelCallId: call.id,
        },
        async (_, tx) => {
          await this.guard(lease, tx);
          await tx
            .update(growthCandidates)
            .set({
              proposal,
              status: valid ? 'queued' : proposal ? 'observing' : 'no_change',
              reason: valid ? null : proposal ? 'growth_evidence_insufficient' : 'growth_no_change',
            })
            .where(
              and(eq(growthCandidates.ownerId, ownerId), eq(growthCandidates.id, candidate.id)),
            );
          if (!valid)
            await this.database.tasks.update(ownerId, lease.task.id, { totalSteps: 1 }, tx);
        },
      );
      if (!valid) {
        await this.jobs.complete(lease, async (_, tx) => {
          await this.guard(lease, tx);
        });
        return;
      }
    }
    if (candidate.status === 'observing' || candidate.status === 'no_change') {
      await this.jobs.complete(lease, async (_, tx) => {
        await this.guard(lease, tx);
      });
      return;
    }
    if (!proposal || !this.supports(proposal, run, assets)) {
      await this.jobs.block(lease, 'growth_evidence_changed');
      return;
    }
    const proposed = proposal;
    const hash = createHash('sha256').update(`growth-validation-v1:${lease.task.id}`).digest('hex');
    const validationId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const call = await this.call(
      lease,
      configVersion,
      'growth_validation',
      validationId,
      JSON.stringify({ ...context, candidate: proposed }),
      growthValidationDefinition,
    );
    if (!call) return;
    const output = growthValidationResultSchema.safeParse(
      call.result?.kind === 'structured' ? call.result.value : null,
    );
    if (!output.success) throw new ApiException(API_CODES.MODEL_OUTPUT_INVALID);
    await this.jobs.checkpoint(lease, {
      completedSteps: 2,
      stage: 'growth_validation',
      modelCallId: call.id,
    });
    await this.jobs.complete(lease, async (_, tx) => {
      const checked = await this.guard(lease, tx);
      const now = await taskDatabaseTime(this.database, ownerId, tx);
      await this.adopt(checked, proposed, output.data, call.id, tx, now);
    });
  }

  /** 验证候选、反思、冻结和预期人格仍然同时有效。 */
  private async guard(lease: TaskLease, tx: DatabaseTransaction) {
    const ownerId = lease.ownerId;
    await this.jobs.guardDispatch(ownerId, tx, lease);
    const [candidate] = await tx
      .select()
      .from(growthCandidates)
      .where(
        and(
          eq(growthCandidates.ownerId, ownerId),
          eq(growthCandidates.id, lease.task.id),
          isNull(growthCandidates.erasedAt),
        ),
      )
      .limit(1);
    if (
      !candidate ||
      candidate.companionId !== lease.task.scope.companionId ||
      candidate.runtimeEpoch !== lease.task.scope.runtimeEpoch ||
      candidate.conversationId !== lease.task.scope.conversationId
    )
      throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
    const { companionId, runtimeEpoch } = candidate;
    const control = await currentGrowthControl(ownerId, companionId, runtimeEpoch, tx);
    const companion = await requireCompanion(this.database, ownerId, companionId, runtimeEpoch, tx);
    if (control.frozen || control.version !== candidate.expectedControlVersion)
      throw new ApiException(API_CODES.TASK_STATE_CONFLICT, '成长控制已更新。');
    if (companion.currentPersonaVersionId !== candidate.expectedPersonaVersionId)
      throw new ApiException(API_CODES.VERSION_CONFLICT);
    const parent = await this.database.personaVersions.findOne(
      ownerId,
      {
        where: { companionId, runtimeEpoch, id: candidate.expectedPersonaVersionId },
      },
      tx,
    );
    const [run] = await tx
      .select()
      .from(reflectionRuns)
      .where(
        and(
          eq(reflectionRuns.ownerId, ownerId),
          eq(reflectionRuns.id, candidate.sourceRunId),
          isNull(reflectionRuns.invalidatedAt),
        ),
      )
      .limit(1);
    if (!parent?.document || !run?.input || !run.result || !run.completedAt)
      throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    return { candidate, parent, companion, run };
  }

  /** 重新展开直接原文和真实成果；反思摘要不能代替证据。 */
  private async assets(run: Run, tx: DatabaseTransaction): Promise<MaterializedEvent[]> {
    const ownerId = run.ownerId;
    const member = await requireCompanionMember(
      this.database,
      ownerId,
      run.companionId,
      run.runtimeEpoch,
      run.conversationId,
      tx,
    );
    if (member.leftSequence !== null || member.deletedAt)
      throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    const rows = await tx
      .select({ event: reflectionEvents })
      .from(reflectionRunEvents)
      .innerJoin(
        reflectionEvents,
        and(
          eq(reflectionEvents.ownerId, ownerId),
          eq(reflectionEvents.id, reflectionRunEvents.eventId),
        ),
      )
      .where(
        and(
          eq(reflectionRunEvents.ownerId, ownerId),
          eq(reflectionRunEvents.runId, run.id),
          ne(reflectionEvents.status, 'invalidated'),
        ),
      )
      .orderBy(asc(reflectionEvents.createdAt), asc(reflectionEvents.id))
      .limit(12);
    const entries = [];
    for (const { event } of rows) {
      try {
        const actual = await materializeReflectionEvent(event, member, tx);
        if (actual) entries.push(actual);
      } catch (error) {
        if (!accessError(error)) throw error;
      }
    }
    return entries;
  }

  /** 支持项必须独立且含新证据，反例只能引用实际输入。 */
  private supports(proposal: GrowthProposal, run: Run, assets: MaterializedEvent[]): boolean {
    const support = new Set(proposal.supportEventIds);
    const counters = new Set(proposal.counterexampleEventIds);
    const selected = assets.filter(({ input }) => support.has(input.eventId));
    return (
      selected.length === support.size &&
      independent(selected) >= 2 &&
      run.input!.events.some((event) => support.has(event.eventId)) &&
      [...counters].every(
        (id) => !support.has(id) && assets.some(({ input }) => input.eventId === id),
      )
    );
  }

  /** 报价和租约仍由 F03/F04 管理，两次调用具有独立请求身份。 */
  private async call(
    lease: TaskLease,
    configVersion: number,
    role: 'growth' | 'growth_validation',
    requestId: string,
    inputText: string,
    definition: ModelTaskDefinition,
  ) {
    const ownerId = lease.ownerId;
    let call = await this.models.execute(
      ownerId,
      {
        requestId,
        expectedConfigVersion: configVersion,
        role,
        operation: 'structured',
        lane: 'background',
        inputText,
      },
      definition,
      lease.task.scope,
      async (_, tx) => {
        const { run } = await this.guard(lease, tx);
        if (independent(await this.assets(run, tx)) < 2)
          throw new ApiException(API_CODES.MODEL_OUTPUT_INVALID);
      },
    );
    while (call.status === 'running') {
      await delay(lease.config.pollMs);
      await this.jobs.heartbeat(lease);
      call = await this.models.get(ownerId, call.id);
    }
    if (call.status === 'unknown') {
      await this.jobs.block(lease, 'model_result_unknown');
      return null;
    }
    if (call.status !== 'succeeded') {
      await this.jobs.fail(lease, 'growth_model_failed');
      return null;
    }
    return call;
  }

  /** 只追加已验证的一项 L1 局部变化，名称、背景和锁定字段由程序保留。 */
  private async adopt(
    checked: Awaited<ReturnType<GrowthExecution['guard']>>,
    proposal: GrowthProposal,
    validation: GrowthValidationResult,
    callId: string,
    tx: DatabaseTransaction,
    now: Date,
  ): Promise<void> {
    const { candidate, companion, parent, run } = checked;
    const ownerId = candidate.ownerId;
    const assets = await this.assets(run, tx);
    const { persona } = await activeGrowth(parent, tx);
    const { topic, dimension, text, applicability } = proposal;
    const last = persona.document!.growth ?? [];
    const existing = last.find((trait) => trait.topic === topic && trait.dimension === dimension);
    const same = existing?.text === text && existing.applicability === applicability;
    let reason: string | null = null;
    if (
      !validation.accept ||
      !validation.evidenceSufficient ||
      !validation.preservesLocks ||
      !validation.localChange
    )
      reason = 'growth_validation_rejected';
    else if (!this.supports(proposal, run, assets)) reason = 'growth_evidence_changed';
    else if (same) reason = 'growth_already_current';
    else if (!existing && last.length >= 12) reason = 'growth_scope_limit';
    else if (!(await this.withinPace(ownerId, companion.id, now, tx)))
      reason = 'growth_rate_limited';
    if (reason) {
      const status =
        reason === 'growth_already_current'
          ? 'no_change'
          : reason === 'growth_validation_rejected'
            ? 'rejected'
            : 'observing';
      await this.updateCandidate(candidate, { validation, status, reason }, tx);
      return;
    }
    const trait: GrowthTrait = { growthId: candidate.id, topic, dimension, text, applicability };
    const growth = last.filter((item) => item !== existing).concat(trait);
    const document = personaDocumentSchema.parse({ ...parent.document!, growth });
    const version = await appendGrowthPersona(
      this.database,
      companion,
      parent,
      document,
      {
        origin: 'growth',
        mode: candidate.mode,
        modelCallId: callId,
        commandId: null,
        commandFingerprint: null,
      },
      tx,
      now,
    );
    await this.updateCandidate(
      candidate,
      {
        validation,
        status: 'adopted',
        adoptedPersonaVersionId: version.id,
        adoptedAt: now,
      },
      tx,
    );
  }

  /** 调度和采用使用同一持久节奏，重启、回退及换代次不清零。 */
  private async withinPace(
    ownerId: string,
    companionId: string,
    now: Date,
    tx: DatabaseTransaction,
  ): Promise<boolean> {
    const [recent] = await tx
      .select({ id: growthCandidates.id })
      .from(growthCandidates)
      .where(
        and(
          eq(growthCandidates.ownerId, ownerId),
          eq(growthCandidates.companionId, companionId),
          gte(
            growthCandidates.adoptedAt,
            new Date(now.getTime() - this.limits.minimumAdoptionIntervalMs),
          ),
        ),
      )
      .limit(1);
    return !recent;
  }

  /** 呈现实际验证和提交决定。 */
  private async updateCandidate(
    candidate: Candidate,
    set: Partial<
      Pick<Candidate, 'validation' | 'status' | 'reason' | 'adoptedAt' | 'adoptedPersonaVersionId'>
    >,
    tx: DatabaseTransaction,
  ): Promise<void> {
    await tx
      .update(growthCandidates)
      .set(set)
      .where(
        and(eq(growthCandidates.ownerId, candidate.ownerId), eq(growthCandidates.id, candidate.id)),
      );
  }
}

/** 同一作品或相同的原文集合只算单一经历，纯他人陈述不算自主成长。 */
function independent(assets: MaterializedEvent[]): number {
  const domains = new Set<string>();
  const originals = new Set<string>();
  let count = 0;
  for (const { input, refs } of assets) {
    if (input.treatment === 'other_report') continue;
    const domain = `${input.kind}:${input.sourceId}`;
    const key = refs
      .map(({ messageId, contentVersion }) => `${messageId}:${contentVersion}`)
      .sort()
      .join('|');
    if (domains.has(domain) || (key && originals.has(key))) continue;
    domains.add(domain);
    if (key) originals.add(key);
    count++;
  }
  return count;
}
