import { Inject, Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import type { ActivityScope, ReflectionStart } from '@memory-weave/contracts';
import { and, asc, desc, eq, gt, gte, inArray, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { SERVER_CONFIG } from '../../config';
import type { ServerConfig } from '../../config';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  reflectionEvents,
  reflectionFindings,
  reflectionRunEvents,
  reflectionRunMessages,
  reflectionRuns,
  tasks,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { requireCompanionMember } from '../conversations/conversation-access';
import { ModelConfigurationService } from '../models/model-configuration.service';
import { modelInputReservation } from '../models/model-runtime.service';
import { fingerprint } from '../shared/http';
import { TaskStore } from '../tasks/task-store';
import { reflectionConfigurationSchema } from './reflection-config';
import type { ReflectionConfiguration } from './reflection-config';
import { reflectionDefinition } from './reflection-definition';
import { materializeReflectionEvent, reflectionOriginals } from './reflection-input';
import type { OriginalRef } from './reflection-input';
import type { ReflectionInput } from './reflection-types';

/** 待反思内容与轮次预算均持久，扫描不产生外部调用。 */
@Injectable()
export class ReflectionPlanning {
  private readonly limits: ReflectionConfiguration;
  private scanAfter: string | null = null;
  private nextScanAt = 0;

  /** 初始化部署可配置的反思调度参数。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(ModelConfigurationService) private readonly configuration: ModelConfigurationService,
    @Inject(SERVER_CONFIG) config: ServerConfig,
  ) {
    this.limits = reflectionConfigurationSchema.parse(config.reflectionConfiguration ?? {});
  }

  /** 用户可唤醒有依据的检查，额度和并发条件仍然生效。 */
  async start(ownerId: string, scope: ActivityScope): Promise<ReflectionStart> {
    const config = await this.configuration.get(ownerId);
    return this.store.locked(ownerId, (tx, now) =>
      this.plan(ownerId, scope, config, tx, now, true),
    );
  }

  /** 持续检查有限队列页，不把普通定时唤醒转成付费调用。 */
  async wake(ownerId: string): Promise<void> {
    if (!this.limits.enabled || Date.now() < this.nextScanAt) return;
    this.nextScanAt = Date.now() + 1000;
    const config = await this.configuration.get(ownerId);
    await this.store.locked(ownerId, async (tx, now) => {
      await this.settleAssignments(ownerId, tx);
      const model = config.config.tasks.reflection;
      if (!model.enabled) return;
      const mode = model.providerId === 'test' ? 'test' : 'model';
      const rows = await tx
        .select()
        .from(reflectionEvents)
        .where(
          and(
            eq(reflectionEvents.ownerId, ownerId),
            eq(reflectionEvents.status, 'pending'),
            eq(reflectionEvents.mode, mode),
            this.scanAfter ? gt(reflectionEvents.id, this.scanAfter) : undefined,
          ),
        )
        .orderBy(asc(reflectionEvents.id))
        .limit(12);
      this.scanAfter = rows.length === 12 ? rows.at(-1)!.id : null;
      const scopes = new Map(
        rows.map((row) => [`${row.companionId}:${row.runtimeEpoch}:${row.conversationId}`, row]),
      );
      for (const scope of scopes.values()) {
        try {
          await this.plan(ownerId, scope, config, tx, now, false);
        } catch (error) {
          if (!accessError(error)) throw error;
        }
      }
    });
  }

  /** 记录已终止任务的事件状态，旧错误阻塞后保留其余独立增量。 */
  private async settleAssignments(ownerId: string, tx: DatabaseTransaction): Promise<void> {
    const rows = await tx
      .select({ eventId: reflectionEvents.id, run: reflectionRuns, status: tasks.status })
      .from(reflectionEvents)
      .innerJoin(
        reflectionRuns,
        and(eq(reflectionRuns.ownerId, ownerId), eq(reflectionRuns.id, reflectionEvents.taskId)),
      )
      .innerJoin(tasks, and(eq(tasks.ownerId, ownerId), eq(tasks.id, reflectionRuns.id)))
      .where(
        and(
          eq(reflectionEvents.ownerId, ownerId),
          eq(reflectionEvents.status, 'assigned'),
          inArray(tasks.status, ['blocked', 'failed', 'cancelled', 'succeeded']),
        ),
      )
      .orderBy(asc(reflectionEvents.id))
      .limit(24);
    for (const { eventId, run, status } of rows)
      await tx
        .update(reflectionEvents)
        .set({
          status: status === 'succeeded' ? 'processed' : run.invalidatedAt ? 'pending' : 'blocked',
          taskId: run.invalidatedAt ? null : run.id,
        })
        .where(and(eq(reflectionEvents.ownerId, ownerId), eq(reflectionEvents.id, eventId)));
  }

  /** 在调度锁内核对范围、真实增量、额度和固定的输入预算。 */
  private async plan(
    ownerId: string,
    scope: ActivityScope,
    config: Awaited<ReturnType<ModelConfigurationService['get']>>,
    tx: DatabaseTransaction,
    now: Date,
    explicit: boolean,
  ): Promise<ReflectionStart> {
    const member = await requireCompanionMember(
      this.database,
      ownerId,
      scope.companionId,
      scope.runtimeEpoch,
      scope.conversationId,
      tx,
    );
    if (member.leftSequence !== null || member.deletedAt)
      throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    const model = config.config.tasks.reflection;
    if (!this.limits.enabled || !model.enabled) return { state: 'disabled', runId: null };
    const mode = model.providerId === 'test' ? 'test' : 'model';
    const [active] = await tx
      .select({ id: reflectionRuns.id })
      .from(reflectionRuns)
      .innerJoin(
        tasks,
        and(
          eq(tasks.ownerId, ownerId),
          eq(tasks.id, reflectionRuns.id),
          inArray(tasks.status, ['queued', 'running', 'paused', 'waiting']),
        ),
      )
      .where(
        and(
          eq(reflectionRuns.ownerId, ownerId),
          eq(reflectionRuns.companionId, scope.companionId),
          eq(reflectionRuns.runtimeEpoch, scope.runtimeEpoch),
          isNull(reflectionRuns.invalidatedAt),
        ),
      )
      .limit(1);
    if (active) return { state: 'already_queued', runId: active.id };
    const rows = await tx
      .select()
      .from(reflectionEvents)
      .where(
        and(
          eq(reflectionEvents.ownerId, ownerId),
          eq(reflectionEvents.companionId, scope.companionId),
          eq(reflectionEvents.runtimeEpoch, scope.runtimeEpoch),
          eq(reflectionEvents.conversationId, scope.conversationId),
          eq(reflectionEvents.status, 'pending'),
          eq(reflectionEvents.mode, mode),
        ),
      )
      .orderBy(
        desc(reflectionEvents.priority),
        asc(reflectionEvents.createdAt),
        asc(reflectionEvents.id),
      )
      .limit(this.limits.batchEvents);
    if (!rows.length) return { state: 'no_meaningful_changes', runId: null };
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const [latest] = await tx
      .select({ at: reflectionRuns.createdAt })
      .from(reflectionRuns)
      .where(
        and(eq(reflectionRuns.ownerId, ownerId), eq(reflectionRuns.companionId, scope.companionId)),
      )
      .orderBy(desc(reflectionRuns.createdAt))
      .limit(1);
    const recent = await tx
      .select({ id: reflectionRuns.id })
      .from(reflectionRuns)
      .where(
        and(
          eq(reflectionRuns.ownerId, ownerId),
          eq(reflectionRuns.companionId, scope.companionId),
          gte(reflectionRuns.createdAt, dayStart),
        ),
      )
      .limit(this.limits.dailyRuns);
    const ordinary = !explicit && rows.every((event) => event.priority === 0);
    const interval = ordinary ? this.limits.routineIntervalMs : this.limits.minimumIntervalMs;
    const since = latest?.at ?? (ordinary ? rows[0]!.createdAt : null);
    if (
      recent.length >= this.limits.dailyRuns ||
      (since && now.getTime() - since.getTime() < interval)
    )
      return { state: 'rate_limited', runId: null };
    const input: ReflectionInput = { events: [], earlier: [] };
    const refs: OriginalRef[] = [];
    const eventIds = new Set<string>();
    const invalid: string[] = [];
    for (const row of rows) {
      try {
        const actual = await materializeReflectionEvent(row, member, tx);
        if (!actual) {
          invalid.push(row.id);
          continue;
        }
        const next = { ...input, events: [...input.events, actual.input] };
        if (
          modelInputReservation(JSON.stringify(next), reflectionDefinition, 'structured') >
          model.maxInputTokens
        )
          break;
        input.events.push(actual.input);
        refs.push(...actual.refs);
        eventIds.add(row.id);
      } catch (error) {
        if (!accessError(error)) throw error;
        invalid.push(row.id);
      }
    }
    if (invalid.length)
      await tx
        .update(reflectionEvents)
        .set({ status: 'invalidated' })
        .where(and(eq(reflectionEvents.ownerId, ownerId), inArray(reflectionEvents.id, invalid)));
    if (!input.events.length)
      return {
        state: rows.length === invalid.length ? 'no_meaningful_changes' : 'input_budget',
        runId: null,
      };

    const earlier = await tx
      .select()
      .from(reflectionFindings)
      .where(
        and(
          eq(reflectionFindings.ownerId, ownerId),
          eq(reflectionFindings.companionId, scope.companionId),
          eq(reflectionFindings.runtimeEpoch, scope.runtimeEpoch),
          eq(reflectionFindings.conversationId, scope.conversationId),
          eq(reflectionFindings.status, 'current'),
          eq(reflectionFindings.mode, mode),
        ),
      )
      .orderBy(desc(reflectionFindings.createdAt), asc(reflectionFindings.id))
      .limit(4);
    for (const previous of earlier) {
      if (!previous.document) continue;
      const known = {
        kind: previous.kind,
        topic: previous.topic,
        interpretation: previous.document.interpretation,
      };
      if (
        modelInputReservation(
          JSON.stringify({ ...input, earlier: [...input.earlier, known] }),
          reflectionDefinition,
          'structured',
        ) > model.maxInputTokens
      )
        break;
      const priorRefs = await tx
        .select({
          messageId: reflectionRunMessages.messageId,
          contentVersion: reflectionRunMessages.contentVersion,
        })
        .from(reflectionRunMessages)
        .where(
          and(
            eq(reflectionRunMessages.ownerId, ownerId),
            eq(reflectionRunMessages.runId, previous.runId),
          ),
        );
      try {
        await reflectionOriginals(member, priorRefs, tx);
      } catch (error) {
        if (!accessError(error)) throw error;
        continue;
      }
      const priorEvents = await tx
        .select({ id: reflectionRunEvents.eventId })
        .from(reflectionRunEvents)
        .where(
          and(
            eq(reflectionRunEvents.ownerId, ownerId),
            eq(reflectionRunEvents.runId, previous.runId),
          ),
        );
      // 只纳入可完整登记依赖的历史版本，限制连续复盘的引用规模。
      const provenance = new Set([...refs, ...priorRefs].map((ref) => ref.messageId));
      const historicalEvents = new Set([...eventIds, ...priorEvents.map((ref) => ref.id)]);
      if (provenance.size > 192 || historicalEvents.size > 32) continue;
      input.earlier.push(known);
      refs.push(...priorRefs);
      for (const prior of priorEvents) eventIds.add(prior.id);
    }

    const taskId = randomUUID();
    const scopeValue = {
      companionId: scope.companionId,
      runtimeEpoch: scope.runtimeEpoch,
      conversationId: scope.conversationId,
    };
    const assigned = input.events.map((item) => item.eventId);
    await this.database.tasks.insert(
      ownerId,
      {
        id: taskId,
        kind: 'reflection',
        input: { kind: 'reflection', configVersion: config.version },
        requestKey: `reflection:${taskId}`,
        fingerprint: fingerprint(assigned),
        scope: scopeValue,
        totalSteps: 1,
        availableAt: now,
      },
      tx,
    );
    await tx.insert(reflectionRuns).values({
      ...scopeValue,
      id: taskId,
      ownerId,
      mode,
      input,
      eventCount: assigned.length,
      createdAt: now,
    });
    await tx
      .insert(reflectionRunEvents)
      .values([...eventIds].map((eventId) => ({ ownerId, runId: taskId, eventId })));
    const originals = [
      ...new Map(refs.map((ref) => [`${ref.messageId}:${ref.contentVersion}`, ref])).values(),
    ];
    if (originals.length)
      await tx.insert(reflectionRunMessages).values(
        originals.map(({ messageId, contentVersion }) => ({
          ownerId,
          runId: taskId,
          messageId,
          contentVersion,
        })),
      );
    await tx
      .update(reflectionEvents)
      .set({ status: 'assigned', taskId })
      .where(and(eq(reflectionEvents.ownerId, ownerId), inArray(reflectionEvents.id, assigned)));
    return { state: 'queued', runId: taskId };
  }
}

/** 仅忽略已有领域原因，连接故障交给持久调度重试。 */
export function accessError(error: unknown): boolean {
  return (
    error instanceof ApiException &&
    [
      API_CODES.RESOURCE_NOT_FOUND,
      API_CODES.LIFECYCLE_RESTRICTED,
      API_CODES.RUNTIME_EPOCH_MISMATCH,
    ].some((code) => code === error.code)
  );
}
