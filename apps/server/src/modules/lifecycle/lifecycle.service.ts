import { DatabaseService } from '../../database/database.service';
import type {
  IdPaginationQuery,
  LifecycleCommand,
  LifecycleList,
  LifecycleOperation,
  RetryLifecycle,
} from '@memory-weave/contracts';
import { API_CODES } from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  conversations,
  lifecycleMessageTargets,
  lifecycleOperations,
  messages,
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
import { LIFECYCLE_STAGES } from './lifecycle-cleanup';

/** 先持久记录限制与任务，清理成功之前不能继续使用被停止的状态。 */
@Injectable()
export class LifecycleService {
  /** 初始化生命周期操作管理服务。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ModelConfigurationService) private readonly models: ModelConfigurationService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(TasksService) private readonly jobs: TasksService,
  ) {}

  /**
   * 创建消息删除、伴侣重置或伴侣删除操作。
   *
   * 三种命令共享幂等日志；记录只包含目标身份，不复制业务正文。
   */
  create(ownerId: string, input: LifecycleCommand): Promise<LifecycleOperation> {
    return this.models.locked(ownerId, async (tx) => {
      await lockTaskScheduler(this.database, ownerId, tx);
      const hash = fingerprint(input);
      const existing = await this.database.lifecycleOperations.findOne(
        ownerId,
        {
          where: { requestId: input.requestId },
        },
        tx,
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
        const busy = await this.database.conversations.findOne(
          ownerId,
          {
            where: and(
              affected,
              or(
                isNotNull(conversations.lifecycleOperationId),
                gte(conversations.version, 2147483647),
                gte(conversations.contentRevision, 2147483647),
              ),
            ),
            fields: { id: conversations.id },
          },
          tx,
        );
        if (busy) throw new ApiException(API_CODES.LIFECYCLE_RESTRICTED);
        await this.database.lifecycleOperations.insert(
          ownerId,
          {
            id,
            requestId: input.requestId,
            taskId: id,
            fingerprint: hash,
            kind: input.kind,
            conversationId: conversation.id,
          },
          tx,
        );
        await tx.insert(lifecycleMessageTargets).values(
          selected.map((row) => ({
            ownerId,
            operationId: id,
            messageId: row.id,
            contentVersion: row.contentVersion,
            kind: 'selected' as const,
          })),
        );
        await this.database.conversations.updateWhere(
          ownerId,
          {
            where: affected,
            set: {
              lifecycleOperationId: id,
              contentRevision: sql`${conversations.contentRevision} + 1`,
              version: sql`${conversations.version} + 1`,
            },
          },
          tx,
        );
        await this.database.tasks.insert(
          ownerId,
          {
            id,
            requestKey: `lifecycle:${input.requestId.toLowerCase()}`,
            fingerprint: hash,
            kind: 'lifecycle_cleanup',
            input: { kind: 'lifecycle_cleanup', operationId: id },
            scope: { companionId: null, runtimeEpoch: null, conversationId: null },
            totalSteps: LIFECYCLE_STAGES.length,
          },
          tx,
        );
        return this.read(ownerId, tx, id);
      }
      const companion = await requireCompanion(
        this.database,
        ownerId,
        input.companionId,
        input.runtimeEpoch,
        tx,
      );
      if (companion.version !== input.expectedVersion)
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      if (companion.version >= 2147483647 || companion.runtimeEpoch >= 2147483647)
        throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
      const id = randomUUID();
      const nextEpoch = input.kind === 'reset_companion' ? companion.runtimeEpoch + 1 : null;
      await this.database.lifecycleOperations.insert(
        ownerId,
        {
          id,
          requestId: input.requestId,
          taskId: id,
          fingerprint: hash,
          kind: input.kind,
          companionId: companion.id,
          previousEpoch: companion.runtimeEpoch,
          nextEpoch,
        },
        tx,
      );
      if (nextEpoch) {
        const foundation = await this.database.personaFoundations.findOne(
          ownerId,
          {
            where: { companionId: companion.id, runtimeEpoch: companion.runtimeEpoch },
          },
          tx,
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
        await this.database.personaVersions.insert(
          ownerId,
          {
            id: personaId,
            companionId: companion.id,
            runtimeEpoch: nextEpoch,
            version: 1,
            profileText: companion.initialSnapshot!.profileText,
            document: initial?.document ?? null,
            origin: 'reset',
            mode: initial?.mode ?? null,
          },
          tx,
        );
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
        await this.database.companions.update(
          ownerId,
          companion.id,
          {
            runtimeEpoch: nextEpoch,
            version: companion.version + 1,
            currentPersonaVersionId: personaId,
            lifecycleOperationId: id,
          },
          tx,
        );
      } else {
        await this.database.conversationMembers.updateWhere(
          ownerId,
          {
            where: { companionId: companion.id },
            set: { deletedAt: new Date() },
          },
          tx,
        );
        await this.database.companions.update(
          ownerId,
          companion.id,
          {
            version: companion.version + 1,
            currentPersonaVersionId: null,
            initialSnapshot: null,
            name: '已删除伴侣',
            deletedAt: new Date(),
            lifecycleOperationId: id,
          },
          tx,
        );
      }
      await this.database.tasks.insert(
        ownerId,
        {
          id,
          requestKey: `lifecycle:${input.requestId.toLowerCase()}`,
          fingerprint: hash,
          kind: 'lifecycle_cleanup',
          input: { kind: 'lifecycle_cleanup', operationId: id },
          scope: { companionId: null, runtimeEpoch: null, conversationId: null },
          totalSteps: LIFECYCLE_STAGES.length,
        },
        tx,
      );
      return this.read(ownerId, tx, id);
    });
  }

  /** 为未完成的生命周期清理创建恢复任务。 */
  retry(ownerId: string, id: string, input: RetryLifecycle): Promise<LifecycleOperation> {
    return this.models.locked(ownerId, async (tx) => {
      await lockTaskScheduler(this.database, ownerId, tx);
      const operation = await this.database.lifecycleOperations.findById(ownerId, id, tx);
      if (!operation) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      const requestKey = `lifecycle_retry:${id}:${input.requestId.toLowerCase()}`;
      const existing = await this.database.tasks.findOne(
        ownerId,
        {
          where: { requestKey },
          fields: { id: tasks.id },
        },
        tx,
      );
      if (existing || operation.completedAt) return this.read(ownerId, tx, id);
      const previous = await this.jobs.getInTransaction(ownerId, operation.taskId, tx);
      if (!['failed', 'cancelled', 'blocked', 'paused'].includes(previous.status))
        throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
      if (previous.status === 'paused')
        await this.jobs.controlInTransaction(ownerId, tx, new Date(), previous.id, 'cancel');
      const taskId = randomUUID();
      await this.database.tasks.insert(
        ownerId,
        {
          id: taskId,
          requestKey,
          fingerprint: fingerprint({ operationId: id }),
          kind: 'lifecycle_cleanup',
          input: { kind: 'lifecycle_cleanup', operationId: id },
          scope: { companionId: null, runtimeEpoch: null, conversationId: null },
          completedSteps: operation.stage,
          totalSteps: LIFECYCLE_STAGES.length,
          stage: LIFECYCLE_STAGES[operation.stage] ?? 'cleanup_complete',
        },
        tx,
      );
      await this.database.lifecycleOperations.update(ownerId, id, { taskId }, tx);
      return this.read(ownerId, tx, id);
    });
  }

  /**
   * 查询生命周期操作的当前状态。
   *
   * 查询不会解除限制或冒充清理已完成。
   */
  get(ownerId: string, id: string): Promise<LifecycleOperation> {
    return this.store.locked(ownerId, (tx) => this.read(ownerId, tx, id));
  }

  /**
   * 分页查询生命周期操作记录。
   *
   * 有界日志不包含已删除正文或人格。
   */
  list(ownerId: string, query: IdPaginationQuery): Promise<LifecycleList> {
    return this.store.locked(ownerId, async (tx) => {
      const rows = await this.database.lifecycleOperations.findMany(
        ownerId,
        {
          where: query.afterId ? gt(lifecycleOperations.id, query.afterId) : undefined,
          fields: { id: lifecycleOperations.id },
          orderBy: [asc(lifecycleOperations.id)],
          limit: query.limit + 1,
        },
        tx,
      );
      return {
        items: await Promise.all(
          rows.slice(0, query.limit).map((row) => this.read(ownerId, tx, row.id)),
        ),
        nextAfterId: rows.length > query.limit ? rows[query.limit - 1]!.id : null,
      };
    });
  }

  /** 读取生命周期操作及其执行任务。 */
  private async read(
    ownerId: string,
    tx: DatabaseTransaction,
    id: string,
  ): Promise<LifecycleOperation> {
    const row = await this.database.lifecycleOperations.findById(ownerId, id, tx);
    if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    return {
      id,
      kind: row.kind,
      companionId: row.companionId,
      conversationId: row.conversationId,
      previousEpoch: row.previousEpoch,
      nextEpoch: row.nextEpoch,
      status: row.completedAt ? 'completed' : 'pending',
      stage: LIFECYCLE_STAGES[row.stage] ?? 'completed',
      processedRecords: row.processedRecords,
      completedStages: row.stage,
      totalStages: LIFECYCLE_STAGES.length,
      task: await this.jobs.getInTransaction(ownerId, row.taskId, tx),
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }
}
