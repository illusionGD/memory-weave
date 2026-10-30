import { API_CODES } from '@memory-weave/contracts';
import type {
  IdPaginationQuery,
  LifecycleCommand,
  RetryLifecycle,
  LifecycleList,
  LifecycleOperation,
} from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, isNotNull, sql, or, gte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  companions,
  conversationMembers,
  conversations,
  messages,
  lifecycleMessageTargets,
  lifecycleOperations,
  personaFoundations,
  personaVersions,
  tasks,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { requireCompanion, requireConversation } from '../conversations/conversation-access';
import { ModelConfigurationService } from '../models/model-configuration.service';
import { fingerprint } from '../shared/http';
import { lockTaskScheduler, TaskStore } from '../tasks/task-store';
import { TasksService } from '../tasks/tasks.service';
import { LIFECYCLE_STAGES, lifecycleStages } from './lifecycle-cleanup';

/** 先持久记录限制与任务，清理成功之前不能继续使用被停止的状态。 */
@Injectable()
export class LifecycleService {
  constructor(
    @Inject(ModelConfigurationService) private readonly models: ModelConfigurationService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(TasksService) private readonly jobs: TasksService,
  ) {}

  /** 三种命令共享幂等日志；记录只包含目标身份，不复制业务正文。 */
  create(input: LifecycleCommand): Promise<LifecycleOperation> {
    return this.models.locked(async (ownerId, tx) => {
      await lockTaskScheduler(ownerId, tx);
      const hash = fingerprint(input);
      const [existing] = await tx
        .select()
        .from(lifecycleOperations)
        .where(
          and(
            eq(lifecycleOperations.ownerId, ownerId),
            eq(lifecycleOperations.requestId, input.requestId),
          ),
        );
      if (existing) {
        if (existing.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return this.read(ownerId, tx, existing.id);
      }
      if (input.kind === 'delete_messages') {
        const conversation = await requireConversation(ownerId, input.conversationId, tx, true);
        if (conversation.version !== input.expectedVersion)
          throw new ApiException(API_CODES.VERSION_CONFLICT);
        if (conversation.version >= 2147483647 || conversation.contentRevision >= 2147483647)
          throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
        const selected = await tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.ownerId, ownerId),
              eq(messages.conversationId, conversation.id),
              inArray(
                messages.id,
                input.messages.map((item) => item.messageId),
              ),
              isNull(messages.deletedAt),
            ),
          );
        if (
          selected.length !== input.messages.length ||
          selected.some(
            (row) =>
              !input.messages.some(
                (item) =>
                  item.messageId.toLowerCase() === row.id &&
                  item.contentVersion === row.contentVersion,
              ),
          )
        )
          throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
        const id = randomUUID();
        // 跨私聊回忆只在同一伴侣与用户之间开放；先限制这组可能依赖的会话，传播完成后统一解除。
        const affected = sql`${conversations.ownerId} = ${ownerId} AND (${conversations.id} = ${conversation.id} OR (${conversations.kind} = 'private' AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = ${conversations.id} AND cm.kind = 'companion' AND cm.companion_id IN (SELECT companion_id FROM conversation_members WHERE conversation_id = ${conversation.id} AND kind = 'companion'))))`;
        const [busy] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              affected,
              or(
                isNotNull(conversations.lifecycleOperationId),
                gte(conversations.version, 2147483647),
                gte(conversations.contentRevision, 2147483647),
              ),
            ),
          )
          .limit(1);
        if (busy) throw new ApiException(API_CODES.LIFECYCLE_RESTRICTED);
        await tx.insert(lifecycleOperations).values({
          id,
          ownerId,
          requestId: input.requestId,
          taskId: id,
          fingerprint: hash,
          protocolVersion: 4,
          kind: input.kind,
          conversationId: conversation.id,
        });
        await tx.insert(lifecycleMessageTargets).values(
          selected.map((row) => ({
            ownerId,
            operationId: id,
            messageId: row.id,
            contentVersion: row.contentVersion,
            kind: 'selected' as const,
          })),
        );
        await tx
          .update(conversations)
          .set({
            lifecycleOperationId: id,
            contentRevision: sql`${conversations.contentRevision} + 1`,
            version: sql`${conversations.version} + 1`,
          })
          .where(affected);
        await tx.insert(tasks).values({
          id,
          ownerId,
          requestKey: `lifecycle:${input.requestId.toLowerCase()}`,
          fingerprint: hash,
          kind: 'lifecycle_cleanup',
          input: { kind: 'lifecycle_cleanup', operationId: id },
          scope: { companionId: null, runtimeEpoch: null, conversationId: null },
          totalSteps: LIFECYCLE_STAGES.length,
        });
        return this.read(ownerId, tx, id);
      }
      const companion = await requireCompanion(ownerId, input.companionId, input.runtimeEpoch, tx);
      if (companion.version !== input.expectedVersion)
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      if (companion.version >= 2147483647 || companion.runtimeEpoch >= 2147483647)
        throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
      const id = randomUUID();
      const nextEpoch = input.kind === 'reset_companion' ? companion.runtimeEpoch + 1 : null;
      await tx.insert(lifecycleOperations).values({
        id,
        ownerId,
        requestId: input.requestId,
        taskId: id,
        fingerprint: hash,
        protocolVersion: 4,
        kind: input.kind,
        companionId: companion.id,
        previousEpoch: companion.runtimeEpoch,
        nextEpoch,
      });
      if (nextEpoch) {
        const [foundation] = await tx
          .select()
          .from(personaFoundations)
          .where(
            and(
              eq(personaFoundations.ownerId, ownerId),
              eq(personaFoundations.companionId, companion.id),
              eq(personaFoundations.runtimeEpoch, companion.runtimeEpoch),
            ),
          );
        const [initial] = foundation?.initialPersonaVersionId
          ? await tx
              .select()
              .from(personaVersions)
              .where(
                and(
                  eq(personaVersions.ownerId, ownerId),
                  eq(personaVersions.id, foundation.initialPersonaVersionId),
                ),
              )
          : [];
        const personaId = randomUUID();
        await tx.insert(personaVersions).values({
          id: personaId,
          ownerId,
          companionId: companion.id,
          runtimeEpoch: nextEpoch,
          version: 1,
          profileText: companion.initialSnapshot!.profileText,
          document: initial?.document ?? null,
          origin: 'reset',
          mode: initial?.mode ?? null,
        });
        if (foundation) {
          await tx.delete(personaFoundations).where(eq(personaFoundations.id, foundation.id));
          await tx.insert(personaFoundations).values({
            ...foundation,
            id: randomUUID(),
            runtimeEpoch: nextEpoch,
            taskId: null,
            initialPersonaVersionId: initial?.document ? personaId : null,
          });
        }
        await tx
          .update(companions)
          .set({
            runtimeEpoch: nextEpoch,
            version: companion.version + 1,
            currentPersonaVersionId: personaId,
            lifecycleOperationId: id,
          })
          .where(eq(companions.id, companion.id));
      } else {
        await tx
          .update(conversationMembers)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(conversationMembers.ownerId, ownerId),
              eq(conversationMembers.companionId, companion.id),
            ),
          );
        await tx
          .update(companions)
          .set({
            version: companion.version + 1,
            currentPersonaVersionId: null,
            initialSnapshot: null,
            name: '已删除伴侣',
            deletedAt: new Date(),
            lifecycleOperationId: id,
          })
          .where(eq(companions.id, companion.id));
      }
      await tx.insert(tasks).values({
        id,
        ownerId,
        requestKey: `lifecycle:${input.requestId.toLowerCase()}`,
        fingerprint: hash,
        kind: 'lifecycle_cleanup',
        input: { kind: 'lifecycle_cleanup', operationId: id },
        scope: { companionId: null, runtimeEpoch: null, conversationId: null },
        totalSteps: LIFECYCLE_STAGES.length,
      });
      return this.read(ownerId, tx, id);
    });
  }

  /** 清理沿用数据库与外部存储检查点，显式恢复创建新尝试身份并沿用已提交进度。 */
  retry(id: string, input: RetryLifecycle): Promise<LifecycleOperation> {
    return this.models.locked(async (ownerId, tx) => {
      await lockTaskScheduler(ownerId, tx);
      const [operation] = await tx
        .select()
        .from(lifecycleOperations)
        .where(and(eq(lifecycleOperations.ownerId, ownerId), eq(lifecycleOperations.id, id)));
      if (!operation) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      const requestKey = `lifecycle_retry:${id}:${input.requestId.toLowerCase()}`;
      const [existing] = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.ownerId, ownerId), eq(tasks.requestKey, requestKey)));
      if (existing || operation.completedAt) return this.read(ownerId, tx, id);
      const previous = await this.jobs.getInTransaction(ownerId, operation.taskId, tx);
      if (!['failed', 'cancelled', 'blocked', 'paused'].includes(previous.status))
        throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
      if (previous.status === 'paused')
        await this.jobs.controlInTransaction(ownerId, tx, new Date(), previous.id, 'cancel');
      const taskId = randomUUID();
      await tx.insert(tasks).values({
        id: taskId,
        ownerId,
        requestKey,
        fingerprint: fingerprint({ operationId: id }),
        kind: 'lifecycle_cleanup',
        input: { kind: 'lifecycle_cleanup', operationId: id },
        scope: { companionId: null, runtimeEpoch: null, conversationId: null },
        completedSteps: operation.stage,
        totalSteps: lifecycleStages(operation.protocolVersion).length,
        stage: lifecycleStages(operation.protocolVersion)[operation.stage] ?? 'cleanup_complete',
      });
      await tx.update(lifecycleOperations).set({ taskId }).where(eq(lifecycleOperations.id, id));
      return this.read(ownerId, tx, id);
    });
  }

  /** 查询不会解除限制或冒充清理已完成。 */
  get(id: string): Promise<LifecycleOperation> {
    return this.store.locked((ownerId, tx) => this.read(ownerId, tx, id));
  }

  /** 有界日志不包含已删除正文或人格。 */
  list(query: IdPaginationQuery): Promise<LifecycleList> {
    return this.store.locked(async (ownerId, tx) => {
      const rows = await tx
        .select({ id: lifecycleOperations.id })
        .from(lifecycleOperations)
        .where(
          and(
            eq(lifecycleOperations.ownerId, ownerId),
            query.afterId ? gt(lifecycleOperations.id, query.afterId) : undefined,
          ),
        )
        .orderBy(asc(lifecycleOperations.id))
        .limit(query.limit + 1);
      return {
        items: await Promise.all(
          rows.slice(0, query.limit).map((row) => this.read(ownerId, tx, row.id)),
        ),
        nextAfterId: rows.length > query.limit ? rows[query.limit - 1]!.id : null,
      };
    });
  }

  /** 在调用方事务中取得日志和对应持久任务。 */
  private async read(
    ownerId: string,
    tx: DatabaseTransaction,
    id: string,
  ): Promise<LifecycleOperation> {
    const [row] = await tx
      .select()
      .from(lifecycleOperations)
      .where(and(eq(lifecycleOperations.ownerId, ownerId), eq(lifecycleOperations.id, id)));
    if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    return {
      id,
      kind: row.kind,
      companionId: row.companionId,
      conversationId: row.conversationId,
      previousEpoch: row.previousEpoch,
      nextEpoch: row.nextEpoch,
      status: row.completedAt ? 'completed' : 'pending',
      stage: lifecycleStages(row.protocolVersion)[row.stage] ?? 'completed',
      processedRecords: row.processedRecords,
      completedStages: row.stage,
      totalStages: lifecycleStages(row.protocolVersion).length,
      task: await this.jobs.getInTransaction(ownerId, row.taskId, tx),
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }
}
