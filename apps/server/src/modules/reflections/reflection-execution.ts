import { GrowthExecution } from '../growth/growth-execution';
import { Inject, Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import type { ReflectionEvidence } from '@memory-weave/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  reflectionEvents,
  reflectionFindings,
  reflectionRunEvents,
  reflectionRunMessages,
  reflectionRuns,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { requireCompanionMember } from '../conversations/conversation-access';
import { ModelRuntimeService } from '../models/model-runtime.service';
import { TaskStore, taskDatabaseTime } from '../tasks/task-store';
import type { TaskLease } from '../tasks/task-types';
import { TasksService } from '../tasks/tasks.service';
import { reflectionDefinition, reflectionOutputSchema } from './reflection-definition';
import type { ReflectionOutput } from './reflection-definition';
import { reflectionOriginals } from './reflection-input';
import type { ReflectionInput, ReflectionRunResult } from './reflection-types';

type Run = typeof reflectionRuns.$inferSelect;
type Finding = ReflectionOutput['findings'][number];

/** 反思调用结果、认识版本和实际采用状态以同一任务协议提交。 */
@Injectable()
export class ReflectionExecution {
  /** 初始化反思后台执行。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(TasksService) private readonly jobs: TasksService,
    @Inject(ModelRuntimeService) private readonly models: ModelRuntimeService,
    @Inject(GrowthExecution) private readonly growth: GrowthExecution,
  ) {}

  /** 使用持久的有界输入处理增量，未知结果沿用同一调用身份。 */
  async execute(lease: TaskLease): Promise<void> {
    if (lease.input.kind !== 'reflection') throw new TypeError('反思任务类型无效。');
    const { configVersion } = lease.input;
    const ownerId = lease.ownerId;
    const run = await this.store.locked(ownerId, (tx) => this.guard(lease, tx));
    const input = run.input!;
    let call = await this.models.execute(
      ownerId,
      {
        requestId: run.id,
        expectedConfigVersion: configVersion,
        role: 'reflection',
        operation: 'structured',
        lane: 'background',
        inputText: reflectionJson(input),
      },
      reflectionDefinition,
      lease.task.scope,
      async (_ownerId, tx) => {
        await this.guard(lease, tx);
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
    const output = reflectionOutputSchema.safeParse(
      call.result?.kind === 'structured' ? call.result.value : null,
    );
    if (call.status !== 'succeeded' || !output.success) {
      await this.jobs.fail(lease, 'reflection_model_failed');
      return;
    }
    await this.jobs.checkpoint(lease, {
      completedSteps: 1,
      stage: 'reflection_candidate',
      modelCallId: call.id,
    });
    await this.jobs.complete(lease, async (_, tx) => {
      const run = await this.guard(lease, tx);
      const now = await taskDatabaseTime(this.database, ownerId, tx);
      const result = await this.adopt(run, output.data, tx, now);
      if (result.adopted) await this.growth.schedule(run, configVersion, tx, now);
      await tx
        .update(reflectionRuns)
        .set({ result, completedAt: now })
        .where(and(eq(reflectionRuns.ownerId, ownerId), eq(reflectionRuns.id, run.id)));
      await tx
        .update(reflectionEvents)
        .set({ status: 'processed' })
        .where(
          and(
            eq(reflectionEvents.ownerId, ownerId),
            eq(reflectionEvents.taskId, run.id),
            eq(reflectionEvents.status, 'assigned'),
          ),
        );
    });
  }

  /** 派发、恢复和采用前重查运行代次及所有输入证据。 */
  private async guard(lease: TaskLease, tx: DatabaseTransaction): Promise<Run> {
    const ownerId = lease.ownerId;
    await this.jobs.guardDispatch(ownerId, tx, lease);
    const [run] = await tx
      .select()
      .from(reflectionRuns)
      .where(and(eq(reflectionRuns.ownerId, ownerId), eq(reflectionRuns.id, lease.task.id)))
      .limit(1);
    if (
      !run?.input ||
      run.invalidatedAt ||
      run.completedAt ||
      run.companionId !== lease.task.scope.companionId ||
      run.runtimeEpoch !== lease.task.scope.runtimeEpoch ||
      run.conversationId !== lease.task.scope.conversationId
    )
      throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
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
    const refs = await tx
      .select({
        messageId: reflectionRunMessages.messageId,
        contentVersion: reflectionRunMessages.contentVersion,
      })
      .from(reflectionRunMessages)
      .where(
        and(eq(reflectionRunMessages.ownerId, ownerId), eq(reflectionRunMessages.runId, run.id)),
      );
    await reflectionOriginals(member, refs, tx);
    const dependencies = await tx
      .select({
        id: reflectionEvents.id,
        taskId: reflectionEvents.taskId,
        status: reflectionEvents.status,
      })
      .from(reflectionRunEvents)
      .innerJoin(
        reflectionEvents,
        and(
          eq(reflectionEvents.ownerId, ownerId),
          eq(reflectionEvents.id, reflectionRunEvents.eventId),
        ),
      )
      .where(and(eq(reflectionRunEvents.ownerId, ownerId), eq(reflectionRunEvents.runId, run.id)));
    if (
      dependencies.some((item) => item.status === 'invalidated') ||
      run.input.events.some(
        ({ eventId }) =>
          !dependencies.some(
            (item) => item.id === eventId && item.taskId === run.id && item.status === 'assigned',
          ),
      )
    )
      throw new ApiException(API_CODES.VERSION_CONFLICT);
    return run;
  }

  /** 独立校验候选，记录是否采用或继续观察。 */
  private async adopt(
    run: Run,
    output: ReflectionOutput,
    tx: DatabaseTransaction,
    now: Date,
  ): Promise<ReflectionRunResult> {
    const counters = { adopted: 0, observing: 0, rejected: 0 };
    const seen = new Set<string>();
    for (const finding of output.findings) {
      const key = `${finding.kind}:${finding.topic}`;
      const evidence = validateEvidence(finding, run.input!);
      if (!evidence || seen.has(key)) {
        counters.rejected++;
        continue;
      }
      seen.add(key);
      const status = finding.disposition === 'adopt' ? 'current' : 'observing';
      await this.save(run, finding, status, evidence, tx, now);
      if (status === 'current') counters.adopted++;
      else counters.observing++;
    }
    return { conclusion: output.conclusion, ...counters };
  }

  /** 只在实际采用时替换当前认识，候选观察保留独立版本。 */
  private async save(
    run: Run,
    finding: Finding,
    status: 'current' | 'observing',
    evidence: ReflectionEvidence[],
    tx: DatabaseTransaction,
    now: Date,
  ): Promise<void> {
    const { ownerId, companionId, runtimeEpoch, conversationId, mode } = run;
    const { kind, topic, account, interpretation, applicability, uncertainty } = finding;
    const match = and(
      eq(reflectionFindings.ownerId, ownerId),
      eq(reflectionFindings.companionId, companionId),
      eq(reflectionFindings.runtimeEpoch, runtimeEpoch),
      eq(reflectionFindings.conversationId, conversationId),
      eq(reflectionFindings.mode, mode),
      eq(reflectionFindings.kind, kind),
      eq(reflectionFindings.topic, topic),
    );
    const [previous] = await tx
      .select()
      .from(reflectionFindings)
      .where(match)
      .orderBy(desc(reflectionFindings.version))
      .limit(1);
    const version = (previous?.version ?? 0) + 1;
    if (version > 2_147_483_647) throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
    if (status === 'current')
      await tx
        .update(reflectionFindings)
        .set({ status: 'historical' })
        .where(and(match, eq(reflectionFindings.status, 'current')));
    const id = randomUUID();
    await tx.insert(reflectionFindings).values({
      id,
      ownerId,
      rootId: previous?.rootId ?? id,
      runId: run.id,
      companionId,
      runtimeEpoch,
      conversationId,
      kind,
      topic,
      version,
      status,
      mode,
      document: { account, interpretation, applicability, uncertainty },
      evidence,
      createdAt: now,
    });
  }
}

/** 恢复时按同样字段顺序重建 MySQL 已规范化的 JSON。 */
function reflectionJson(input: ReflectionInput): string {
  return JSON.stringify({
    events: input.events.map(
      ({ eventId, kind, sourceId, sourceVersion, text, occurredAt, priority, treatment }) => ({
        eventId,
        kind,
        sourceId,
        sourceVersion,
        text,
        occurredAt,
        priority,
        treatment,
      }),
    ),
    earlier: input.earlier.map(({ kind, topic, interpretation }) => ({
      kind,
      topic,
      interpretation,
    })),
  });
}

/** 检查精确片段和事实主体，重复引用不累计为不同事件。 */
function validateEvidence(finding: Finding, input: ReflectionInput): ReflectionEvidence[] | null {
  const result = new Map<string, ReflectionEvidence>();
  let independentSupport = false;
  for (const quote of finding.evidence) {
    const source = input.events.find((item) => item.eventId === quote.eventId);
    if (!source || !quote.excerpt.trim() || !source.text.includes(quote.excerpt)) return null;
    if (
      quote.role === 'support' &&
      (finding.kind === 'belief' || source.treatment !== 'other_report')
    )
      independentSupport = true;
    const { eventId, kind, sourceId, sourceVersion } = source;
    result.set(`${eventId}:${quote.role}`, {
      eventId,
      kind,
      sourceId,
      sourceVersion,
      role: quote.role,
      excerpt: quote.excerpt,
    });
  }
  if (finding.disposition === 'adopt' && !independentSupport) return null;
  return [...result.values()];
}
