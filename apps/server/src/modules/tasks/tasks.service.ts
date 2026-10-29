import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { API_CODES } from '@memory-weave/contracts';
import type {
  DiagnosticTask,
  QueuedModelProbe,
  Task,
  TaskConfiguration,
  TaskList,
  TaskListQuery,
} from '@memory-weave/contracts';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  tasks,
  taskAttempts,
  modelCalls,
  companions,
  conversations,
  conversationMembers,
  messages,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { assertVisible, requireCompanionMember } from '../conversations/conversation-access';
import { fingerprint } from '../shared/http';
import { ModelRuntimeService } from '../models/model-runtime.service';
import { TaskStore, lockTaskScheduler, taskDatabaseTime } from './task-store';
import { TaskConfigurationService } from './task-configuration.service';
import type { TaskCheckpoint, TaskLease } from './task-types';

type TaskRow = typeof tasks.$inferSelect;

/** 持久任务控制与 worker 协议；外部访问必须在这些短事务之外。 */
@Injectable()
export class TasksService {
  constructor(
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(TaskConfigurationService) private readonly configuration: TaskConfigurationService,
    @Inject(ModelRuntimeService) private readonly models: ModelRuntimeService,
  ) {}

  /** 创建确定性诊断；同一命令重试只读取原任务，不清零进度。 */
  createDiagnostic(input: DiagnosticTask): Promise<Task> {
    return this.store.locked(async (ownerId, tx) => {
      const requestKey = `diagnostic:${input.requestId.toLowerCase()}`;
      const hash = fingerprint({ steps: input.steps });
      const [existing] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.ownerId, ownerId), eq(tasks.requestKey, requestKey)));
      if (existing) {
        if (existing.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return this.view(existing, tx);
      }
      const id = randomUUID();
      await tx.insert(tasks).values({
        id,
        ownerId,
        requestKey,
        fingerprint: hash,
        kind: 'diagnostic',
        input: { kind: 'diagnostic', steps: input.steps },
        scope: { companionId: null, runtimeEpoch: null, conversationId: null },
        totalSteps: input.steps,
      });
      return this.getInTransaction(ownerId, id, tx);
    });
  }

  /** 模型任务固定调用身份，任何接管都不能换键补发未知请求。 */
  createModelProbe(input: QueuedModelProbe): Promise<Task> {
    return this.store.locked(async (ownerId, tx) => {
      const requestKey = `model_probe:${input.requestId.toLowerCase()}`;
      const hash = fingerprint({ ...input, requestId: input.requestId.toLowerCase() });
      const [existing] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.ownerId, ownerId), eq(tasks.requestKey, requestKey)));
      if (existing) {
        if (existing.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return this.view(existing, tx);
      }
      const id = randomUUID();
      await tx.insert(tasks).values({
        id,
        ownerId,
        requestKey,
        fingerprint: hash,
        kind: 'model_probe',
        input: { kind: 'model_probe', probe: { ...input, requestId: id } },
        scope: { companionId: null, runtimeEpoch: null, conversationId: null },
        totalSteps: 1,
      });
      return this.getInTransaction(ownerId, id, tx);
    });
  }

  /** F03 在实际派发的短事务内核对租约，避免排队期间的取消被忽略。 */
  async guardDispatch(ownerId: string, tx: DatabaseTransaction, lease: TaskLease): Promise<void> {
    await this.requireLease(ownerId, tx, await lockTaskScheduler(ownerId, tx), lease);
    if (!(await this.configuration.current(ownerId, tx)).config.enabled)
      throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
  }

  /** 查询实际状态，必要时将已过期的执行尝试转入有界恢复。 */
  get(id: string): Promise<Task> {
    return this.store.locked(async (ownerId, tx, now) => {
      await this.expire(ownerId, tx, now, (await this.configuration.current(ownerId, tx)).config);
      return this.getInTransaction(ownerId, id, tx);
    });
  }

  /** UUID 游标与状态/实例筛选，不一次加载完整历史。 */
  list(query: TaskListQuery): Promise<TaskList> {
    return this.store.locked(async (ownerId, tx, now) => {
      await this.expire(ownerId, tx, now, (await this.configuration.current(ownerId, tx)).config);
      const rows = await tx
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.ownerId, ownerId),
            query.afterId ? gt(tasks.id, query.afterId) : undefined,
            query.status ? eq(tasks.status, query.status) : undefined,
            query.companionId
              ? sql`JSON_UNQUOTE(JSON_EXTRACT(${tasks.scope}, '$.companionId')) = ${query.companionId.toLowerCase()}`
              : undefined,
          ),
        )
        .orderBy(asc(tasks.id))
        .limit(query.limit + 1);
      return {
        items: await Promise.all(rows.slice(0, query.limit).map((row) => this.view(row, tx))),
        nextAfterId: rows.length > query.limit ? rows[query.limit - 1]!.id : null,
      };
    });
  }

  /** 在部署锁下原子检查容量并领取一个任务；返回后立即释放数据库锁。 */
  claim(): Promise<TaskLease | null> {
    return this.store.locked(async (ownerId, tx, now) => {
      const current = await this.configuration.current(ownerId, tx);
      await this.expire(ownerId, tx, now, current.config);
      if (!current.config.enabled) return null;
      const [active] = await tx
        .select({ value: count() })
        .from(tasks)
        .where(and(eq(tasks.ownerId, ownerId), eq(tasks.status, 'running')));
      if ((active?.value ?? 0) >= current.config.maxConcurrent) return null;
      const [row] = await tx
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.ownerId, ownerId),
            inArray(tasks.status, ['queued', 'waiting']),
            inArray(tasks.kind, [
              'diagnostic',
              'model_probe',
              'persona_initialization',
              'chat_reply',
            ]),
            lte(tasks.availableAt, now),
          ),
        )
        .orderBy(asc(tasks.availableAt), asc(tasks.id))
        .limit(1);
      if (!row) return null;
      if (row.fence >= current.config.maxAttempts) {
        await tx
          .update(tasks)
          .set({ status: 'failed', reason: 'attempt_limit', updatedAt: now })
          .where(eq(tasks.id, row.id));
        return null;
      }
      try {
        await this.checkScope(ownerId, tx, row);
      } catch (error) {
        if (!(error instanceof ApiException)) throw error;
        await tx
          .update(tasks)
          .set({ status: 'blocked', reason: 'scope_changed', updatedAt: now })
          .where(eq(tasks.id, row.id));
        return null;
      }
      const token = randomUUID();
      const fence = row.fence + 1;
      const leaseExpiresAt = new Date(now.getTime() + current.config.leaseMs);
      await tx
        .update(tasks)
        .set({
          status: 'running',
          reason: null,
          fence,
          leaseToken: token,
          leaseExpiresAt,
          updatedAt: now,
        })
        .where(eq(tasks.id, row.id));
      await tx.insert(taskAttempts).values({
        ownerId,
        taskId: row.id,
        number: fence,
        configVersion: current.version,
        config: current.config,
        status: 'running',
        startedAt: now,
        deadlineAt: new Date(now.getTime() + current.config.attemptTimeoutMs),
      });
      return {
        task: await this.getInTransaction(ownerId, row.id, tx),
        token,
        fence,
        input: row.input,
        config: current.config,
      };
    });
  }

  /** 心跳不能复活已过期租约，也不能跨越此次尝试的绝对截止时间。 */
  heartbeat(lease: TaskLease): Promise<void> {
    return this.store.locked(async (ownerId, tx, now) => {
      const row = await this.requireLease(ownerId, tx, now, lease);
      const [attempt] = await tx
        .select()
        .from(taskAttempts)
        .where(
          and(
            eq(taskAttempts.ownerId, ownerId),
            eq(taskAttempts.taskId, row.id),
            eq(taskAttempts.number, row.fence),
          ),
        );
      if (!attempt || attempt.deadlineAt <= now) throw new ApiException(API_CODES.TASK_LEASE_LOST);
      await tx
        .update(tasks)
        .set({
          leaseExpiresAt: new Date(
            Math.min(now.getTime() + attempt.config.leaseMs, attempt.deadlineAt.getTime()),
          ),
        })
        .where(eq(tasks.id, row.id));
    });
  }

  /** 检查点仅单调前进，只有当前有效执行者可以写入。 */
  checkpoint(lease: TaskLease, checkpoint: TaskCheckpoint): Promise<Task> {
    return this.store.locked(async (ownerId, tx, now) => {
      const row = await this.requireLease(ownerId, tx, now, lease);
      if (
        !Number.isSafeInteger(checkpoint.completedSteps) ||
        checkpoint.completedSteps < row.completedSteps ||
        (row.totalSteps !== null && checkpoint.completedSteps > row.totalSteps) ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(checkpoint.stage)
      )
        throw new ApiException(API_CODES.INVALID_REQUEST);
      await tx
        .update(tasks)
        .set({
          completedSteps: checkpoint.completedSteps,
          stage: checkpoint.stage,
          ...(checkpoint.modelCallId ? { modelCallId: checkpoint.modelCallId } : {}),
          updatedAt: now,
        })
        .where(eq(tasks.id, row.id));
      return this.getInTransaction(ownerId, row.id, tx);
    });
  }

  /**
   * 业务结果、精确进度及后续 outbox 由领域回调在同一事务提交。
   * 回调必须再次检查业务版本且不能执行外部操作；重复完成不会再次执行回调。
   */
  complete(
    lease: TaskLease,
    commit?: (ownerId: string, tx: DatabaseTransaction) => Promise<void>,
  ): Promise<Task> {
    return this.store.locked(async (ownerId, tx, now) => {
      const saved = await this.row(ownerId, lease.task.id, tx);
      if (
        saved.status === 'succeeded' &&
        saved.fence === lease.fence &&
        saved.leaseToken === lease.token
      )
        return this.view(saved, tx);
      const row = await this.requireLease(ownerId, tx, now, lease);
      if (row.totalSteps !== null && row.completedSteps !== row.totalSteps)
        throw new ApiException(API_CODES.TASK_STATE_CONFLICT, '实际步骤尚未全部完成。');
      if (
        row.kind === 'model_probe' ||
        row.kind === 'persona_initialization' ||
        row.kind === 'chat_reply'
      ) {
        const [call] = await tx
          .select()
          .from(modelCalls)
          .where(
            and(
              eq(modelCalls.ownerId, ownerId),
              eq(modelCalls.requestId, row.id),
              eq(modelCalls.id, row.modelCallId ?? row.id),
            ),
          );
        if (!call || call.status !== 'succeeded')
          throw new ApiException(API_CODES.TASK_STATE_CONFLICT, '模型结果尚未确认成功。');
      }
      await commit?.(ownerId, tx);
      const committedAt = await taskDatabaseTime(ownerId, tx);
      await this.requireLease(ownerId, tx, committedAt, lease);
      await this.finishAttempt(ownerId, tx, row, committedAt, 'succeeded', null);
      await tx
        .update(tasks)
        .set({
          status: 'succeeded',
          stage: 'completed',
          reason: null,
          leaseExpiresAt: null,
          updatedAt: committedAt,
        })
        .where(eq(tasks.id, row.id));
      return this.getInTransaction(ownerId, row.id, tx);
    });
  }

  /** 管理者改变任务运行状态；租约立即失效，外部已发出的动作仍需核对。 */
  async control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<Task> {
    const result = await this.store.locked((ownerId, tx, now) =>
      this.controlInTransaction(ownerId, tx, now, id, action),
    );
    if (action === 'cancel' && result.status === 'cancelled' && result.modelCallId)
      await this.models.cancel(result.modelCallId);
    return result;
  }

  /** 域命令在已有调度事务内撤销租约；外部取消须在提交后另行执行。 */
  async controlInTransaction(
    ownerId: string,
    tx: DatabaseTransaction,
    now: Date,
    id: string,
    action: 'pause' | 'resume' | 'cancel',
  ): Promise<Task> {
    const current = await this.configuration.current(ownerId, tx);
    await this.expire(ownerId, tx, now, current.config);
    const row = await this.row(ownerId, id, tx);
    if (action === 'cancel') {
      if (['succeeded', 'cancelled'].includes(row.status)) return this.view(row, tx);
    } else if (action === 'pause') {
      if (row.status === 'paused') return this.view(row, tx);
      if (!['queued', 'waiting', 'running'].includes(row.status))
        throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
    } else {
      if (row.status === 'queued') return this.view(row, tx);
      if (row.status !== 'paused' || row.fence >= current.config.maxAttempts)
        throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
    }
    const status = action === 'cancel' ? 'cancelled' : action === 'pause' ? 'paused' : 'queued';
    if (row.status === 'running')
      await this.finishAttempt(
        ownerId,
        tx,
        row,
        now,
        action === 'pause' ? 'paused' : 'cancelled',
        action === 'pause' ? 'operator_paused' : 'operator_cancelled',
      );
    await tx
      .update(tasks)
      .set({
        status,
        reason:
          action === 'resume'
            ? null
            : action === 'pause'
              ? 'operator_paused'
              : 'operator_cancelled',
        availableAt: now,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(tasks.id, row.id));
    return this.getInTransaction(ownerId, row.id, tx);
  }

  /** 明确可恢复的失败才安排重试；未知外部结果由 block 保留待核对。 */
  fail(lease: TaskLease, reason: string, retryable = false): Promise<Task> {
    return this.settleFailure(lease, reason, retryable, false);
  }

  /** 持久保留阻塞原因，不重新发送未知外部请求。 */
  block(lease: TaskLease, reason: string): Promise<Task> {
    return this.settleFailure(lease, reason, false, true);
  }

  private settleFailure(
    lease: TaskLease,
    reason: string,
    retryable: boolean,
    blocked: boolean,
  ): Promise<Task> {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(reason)) throw new ApiException(API_CODES.INVALID_REQUEST);
    return this.store.locked(async (ownerId, tx, now) => {
      const row = await this.requireLease(ownerId, tx, now, lease, false);
      const current = (await this.configuration.current(ownerId, tx)).config;
      const exhausted = retryable && row.fence >= current.maxAttempts;
      const status = blocked ? 'blocked' : retryable && !exhausted ? 'waiting' : 'failed';
      await this.finishAttempt(ownerId, tx, row, now, blocked ? 'blocked' : 'failed', reason);
      await tx
        .update(tasks)
        .set({
          status,
          reason: exhausted ? 'attempt_limit' : reason,
          availableAt: new Date(
            now.getTime() + (status === 'waiting' ? retryDelay(current, row.fence) : 0),
          ),
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(tasks.id, row.id));
      return this.getInTransaction(ownerId, row.id, tx);
    });
  }

  private async expire(
    ownerId: string,
    tx: DatabaseTransaction,
    now: Date,
    config: TaskConfiguration,
  ): Promise<void> {
    const rows = await tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.ownerId, ownerId),
          eq(tasks.status, 'running'),
          lte(tasks.leaseExpiresAt, now),
        ),
      )
      .limit(4);
    for (const row of rows) {
      await this.finishAttempt(ownerId, tx, row, now, 'expired', 'lease_expired');
      await tx
        .update(tasks)
        .set({
          status: row.fence >= config.maxAttempts ? 'failed' : 'waiting',
          reason: row.fence >= config.maxAttempts ? 'attempt_limit' : 'lease_expired',
          availableAt: new Date(now.getTime() + retryDelay(config, row.fence)),
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(tasks.id, row.id));
    }
  }

  private async requireLease(
    ownerId: string,
    tx: DatabaseTransaction,
    now: Date,
    lease: TaskLease,
    verifyScope = true,
  ): Promise<TaskRow> {
    const row = await this.row(ownerId, lease.task.id, tx);
    if (
      row.status !== 'running' ||
      row.fence !== lease.fence ||
      row.leaseToken !== lease.token ||
      !row.leaseExpiresAt ||
      row.leaseExpiresAt <= now
    )
      throw new ApiException(API_CODES.TASK_LEASE_LOST);
    if (verifyScope) await this.checkScope(ownerId, tx, row);
    if (row.leaseExpiresAt <= (await taskDatabaseTime(ownerId, tx)))
      throw new ApiException(API_CODES.TASK_LEASE_LOST);
    return row;
  }

  /** 域状态及来源版本在提交事务中重查，诊断的空范围不获得任何伴侣权限。 */
  private async checkScope(ownerId: string, tx: DatabaseTransaction, row: TaskRow): Promise<void> {
    const scope = row.scope;
    if (scope.companionId === null && scope.runtimeEpoch === null && scope.conversationId === null)
      return;
    if (
      row.kind === 'persona_initialization' &&
      scope.companionId &&
      scope.runtimeEpoch &&
      scope.conversationId === null
    ) {
      const [companion] = await tx
        .select({ epoch: companions.runtimeEpoch })
        .from(companions)
        .where(and(eq(companions.ownerId, ownerId), eq(companions.id, scope.companionId)))
        .for('update');
      if (!companion || companion.epoch !== scope.runtimeEpoch)
        throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
      return;
    }
    if (!scope.companionId || !scope.runtimeEpoch || !scope.conversationId)
      throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
    await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.ownerId, ownerId), eq(conversations.id, scope.conversationId)))
      .for('update');
    await tx
      .select({ id: companions.id })
      .from(companions)
      .where(and(eq(companions.ownerId, ownerId), eq(companions.id, scope.companionId)))
      .for('update');
    await tx
      .select({ id: conversationMembers.id })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.ownerId, ownerId),
          eq(conversationMembers.conversationId, scope.conversationId),
          eq(conversationMembers.companionId, scope.companionId),
        ),
      )
      .for('update');
    const member = await requireCompanionMember(
      ownerId,
      scope.companionId,
      scope.runtimeEpoch,
      scope.conversationId,
      tx,
    );
    if (row.input.kind === 'memory_extraction') {
      if (member.permissionVersion !== row.input.permissionVersion)
        throw new ApiException(API_CODES.PERMISSION_VERSION_CONFLICT);
      await assertVisible(member, row.input.sequence, tx);
      const [source] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.ownerId, ownerId),
            eq(messages.conversationId, scope.conversationId),
            eq(messages.id, row.input.messageId),
            eq(messages.contentVersion, row.input.contentVersion),
            eq(messages.sequence, row.input.sequence),
            eq(messages.state, 'published'),
          ),
        )
        .for('update');
      if (!source) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    }
  }

  private async finishAttempt(
    ownerId: string,
    tx: DatabaseTransaction,
    row: TaskRow,
    now: Date,
    status: Task['attempts'][number]['status'],
    reason: string | null,
  ): Promise<void> {
    await tx
      .update(taskAttempts)
      .set({ status, reason, finishedAt: now })
      .where(
        and(
          eq(taskAttempts.ownerId, ownerId),
          eq(taskAttempts.taskId, row.id),
          eq(taskAttempts.number, row.fence),
          eq(taskAttempts.status, 'running'),
        ),
      );
  }

  private async row(ownerId: string, id: string, tx: DatabaseTransaction): Promise<TaskRow> {
    const [row] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.ownerId, ownerId), eq(tasks.id, id)));
    if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    return row;
  }

  /** 在调用者已有的调度事务内读取任务，避免嵌套加锁。 */
  async getInTransaction(ownerId: string, id: string, tx: DatabaseTransaction): Promise<Task> {
    return this.view(await this.row(ownerId, id, tx), tx);
  }

  private async view(row: TaskRow, tx: DatabaseTransaction): Promise<Task> {
    const attempts = await tx
      .select()
      .from(taskAttempts)
      .where(and(eq(taskAttempts.ownerId, row.ownerId), eq(taskAttempts.taskId, row.id)))
      .orderBy(asc(taskAttempts.number))
      .limit(10);
    const [call] =
      row.kind === 'model_probe' ||
      row.kind === 'persona_initialization' ||
      row.kind === 'chat_reply'
        ? await tx
            .select({ id: modelCalls.id })
            .from(modelCalls)
            .where(and(eq(modelCalls.ownerId, row.ownerId), eq(modelCalls.requestId, row.id)))
        : [];
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      stage: row.stage,
      progress: { completedSteps: row.completedSteps, totalSteps: row.totalSteps },
      scope: row.scope,
      reason: row.reason,
      modelCallId: row.modelCallId ?? call?.id ?? null,
      availableAt: row.availableAt.toISOString(),
      leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      attempts: attempts.map((attempt) => ({
        number: attempt.number,
        configVersion: attempt.configVersion,
        status: attempt.status,
        reason: attempt.reason,
        startedAt: attempt.startedAt.toISOString(),
        finishedAt: attempt.finishedAt?.toISOString() ?? null,
      })),
    };
  }
}

/** 固定有界指数退避，尝试计数不会因重启或修改配置而归零。 */
function retryDelay(config: TaskConfiguration, attempts: number): number {
  return Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** Math.max(0, attempts - 1));
}
