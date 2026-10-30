import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, ne, sql, or, isNotNull, lte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { API_CODES, retrievalConfigurationSchema } from '@memory-weave/contracts';
import type { RecallIndexList, OrganizeMemory } from '@memory-weave/contracts';
import { SERVER_CONFIG } from '../../config';
import type { RuntimeConfig } from '../../config';
import {
  memoryEntries,
  memoryVersions,
  memorySearchDocuments,
  memoryVectorIndexes,
  tasks,
  modelCalls,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { requireCompanion } from '../conversations/conversation-access';
import { ModelConfigurationService } from '../models/model-configuration.service';
import { ModelRuntimeService } from '../models/model-runtime.service';
import { TaskStore } from '../tasks/task-store';
import { TasksService } from '../tasks/tasks.service';
import type { TaskLease } from '../tasks/task-types';
import { fingerprint } from '../shared/http';
import { registerSearchDocument } from './retrieval-lexical';
import {
  embeddingDefinition,
  embeddingSpace,
  vectorCollection,
  RetrievalVector,
} from './retrieval-vector';
import { requireIndexSource } from './retrieval-index-access';

/** 领域提交登记文档，worker 按当前编码空间补建任务，失败不改变正文或整理进度。 */
@Injectable()
export class RetrievalIndexService {
  constructor(
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(TasksService) private readonly jobs: TasksService,
    @Inject(ModelConfigurationService) private readonly configuration: ModelConfigurationService,
    @Inject(ModelRuntimeService) private readonly models: ModelRuntimeService,
    @Inject(RetrievalVector) private readonly vectors: RetrievalVector,
    @Inject(SERVER_CONFIG) private readonly config: RuntimeConfig,
  ) {}
  /** 有界补齐旧版本词项和新编码空间待办，空轮询不发模型。 */
  async schedule(): Promise<void> {
    const limits = this.config.retrievalConfiguration ?? retrievalConfigurationSchema.parse({});
    const configuration = await this.configuration.get();
    const embedding = configuration.config.tasks.embedding;
    const space = embeddingSpace(embedding, this.config);
    await this.reconcileDeleted(limits.indexBatchSize);
    await this.store.locked(async (ownerId, tx) => {
      const old = await tx
        .select({ entry: memoryEntries, version: memoryVersions })
        .from(memoryVersions)
        .innerJoin(memoryEntries, eq(memoryEntries.id, memoryVersions.memoryId))
        .leftJoin(memorySearchDocuments, eq(memorySearchDocuments.versionId, memoryVersions.id))
        .where(
          and(
            eq(memoryEntries.ownerId, ownerId),
            isNull(memoryVersions.invalidatedAt),
            isNull(memorySearchDocuments.lexicalVersion),
          ),
        )
        .limit(limits.indexBatchSize);
      for (const row of old)
        if (row.version.document)
          await registerSearchDocument(
            ownerId,
            row.version.id,
            row.entry.id,
            {
              companionId: row.entry.companionId,
              runtimeEpoch: row.entry.runtimeEpoch,
              conversationId: row.entry.conversationId,
            },
            row.version.document,
            tx,
          );
      if (!limits.vectorEnabled || !embedding.enabled || embedding.providerId === 'test') return;
      const [waiting] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(
          and(
            eq(tasks.ownerId, ownerId),
            eq(tasks.kind, 'memory_index'),
            inArray(tasks.status, ['queued', 'waiting', 'running']),
          ),
        );
      if (Number(waiting?.count ?? 0) >= limits.indexBatchSize * 2) return;
      const documents = await tx
        .select({ document: memorySearchDocuments, entry: memoryEntries, version: memoryVersions })
        .from(memorySearchDocuments)
        .innerJoin(memoryEntries, eq(memoryEntries.id, memorySearchDocuments.memoryId))
        .innerJoin(memoryVersions, eq(memoryVersions.id, memorySearchDocuments.versionId))
        .leftJoin(
          memoryVectorIndexes,
          and(
            eq(memoryVectorIndexes.ownerId, ownerId),
            eq(memoryVectorIndexes.versionId, memorySearchDocuments.versionId),
            eq(memoryVectorIndexes.space, space),
          ),
        )
        .where(
          and(
            eq(memorySearchDocuments.ownerId, ownerId),
            isNull(memoryVectorIndexes.id),
            isNull(memoryVersions.invalidatedAt),
            ne(memoryEntries.status, 'invalidated'),
            eq(memoryEntries.currentVersionId, memoryVersions.id),
          ),
        )
        .orderBy(asc(memorySearchDocuments.createdAt))
        .limit(limits.indexBatchSize);
      for (const row of documents) {
        const id = randomUUID(),
          taskId = randomUUID();
        const scope = {
          companionId: row.entry.companionId,
          runtimeEpoch: row.entry.runtimeEpoch,
          conversationId: row.entry.conversationId,
        };
        await tx.insert(tasks).values({
          id: taskId,
          ownerId,
          requestKey: `memory_index:${id}`,
          fingerprint: fingerprint({ space, versionId: row.version.id }),
          kind: 'memory_index',
          input: { kind: 'memory_index', indexId: id, modelRequestId: taskId },
          scope,
          totalSteps: 2,
        });
        await tx.insert(memoryVectorIndexes).values({
          id,
          ownerId,
          versionId: row.version.id,
          memoryId: row.entry.id,
          ...scope,
          space,
          collection: vectorCollection(ownerId, space),
          configVersion: configuration.version,
          taskId,
        });
      }
    });
  }
  /** 过期版本停止占据当前向量候选；删除身份周期复查以补偿未知的迟到写入。 */
  private async reconcileDeleted(limit: number): Promise<void> {
    const rows = await this.store.locked((ownerId, tx) =>
      tx
        .select({ index: memoryVectorIndexes })
        .from(memoryVectorIndexes)
        .innerJoin(memoryEntries, eq(memoryEntries.id, memoryVectorIndexes.memoryId))
        .innerJoin(memoryVersions, eq(memoryVersions.id, memoryVectorIndexes.versionId))
        .where(
          and(
            eq(memoryVectorIndexes.ownerId, ownerId),
            or(
              and(
                ne(memoryVectorIndexes.status, 'deleted'),
                or(
                  isNotNull(memoryVersions.invalidatedAt),
                  ne(memoryEntries.currentVersionId, memoryVersions.id),
                ),
              ),
              and(
                eq(memoryVectorIndexes.status, 'deleted'),
                or(
                  isNull(memoryVectorIndexes.reconciledAt),
                  lte(memoryVectorIndexes.reconciledAt, new Date(Date.now() - 60000)),
                ),
              ),
            ),
          ),
        )
        .orderBy(asc(memoryVectorIndexes.reconciledAt), asc(memoryVectorIndexes.id))
        .limit(limit),
    );
    for (const { index } of rows) {
      await this.vectors.remove(index.collection, [index.versionId]);
      await this.store.locked(async (ownerId, tx) => {
        await tx
          .update(memoryVectorIndexes)
          .set({ status: 'deleted', reconciledAt: new Date() })
          .where(
            and(eq(memoryVectorIndexes.ownerId, ownerId), eq(memoryVectorIndexes.id, index.id)),
          );
      });
    }
  }
  /** 模型成功结果可复用；Qdrant 重试只覆盖相同点，不重复生成记忆。 */
  async execute(lease: TaskLease): Promise<void> {
    if (lease.input.kind !== 'memory_index') throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
    const id = lease.input.indexId;
    const row = await this.store.locked((ownerId, tx) => requireIndexSource(ownerId, id, tx));
    const configuration = await this.configuration.getVersion(row.index.configVersion);
    const definition = embeddingDefinition(configuration.config.tasks.embedding);
    let call = await this.models.execute(
      {
        requestId: lease.input.modelRequestId,
        expectedConfigVersion: configuration.version,
        role: 'embedding',
        operation: 'embedding',
        lane: 'background',
        inputText: JSON.stringify(row.version.document),
      },
      definition,
      lease.task.scope,
      (ownerId, tx) => this.jobs.guardDispatch(ownerId, tx, lease),
    );
    while (call.status === 'running') {
      await delay(lease.config.pollMs);
      await this.jobs.heartbeat(lease);
      call = await this.models.get(call.id);
    }
    await this.jobs.checkpoint(lease, {
      completedSteps: Math.max(
        lease.task.progress.completedSteps,
        call.status === 'succeeded' ? 1 : 0,
      ),
      stage: 'index_embedding',
      modelCallId: call.id,
    });
    if (call.status === 'unknown') {
      await this.jobs.block(lease, 'model_result_unknown');
      return;
    }
    if (call.status !== 'succeeded' || call.result?.kind !== 'embedding') {
      await this.jobs.fail(lease, 'embedding_failed');
      return;
    }
    await this.store.locked((ownerId, tx) => this.jobs.guardDispatch(ownerId, tx, lease));
    await this.vectors.upsert(row.index.collection, row.version.id, call.result.vector, {
      owner: row.index.ownerId,
      companion: row.index.companionId,
      epoch: row.index.runtimeEpoch,
      conversation: row.index.conversationId,
      space: row.index.space,
    });
    try {
      await this.jobs.checkpoint(lease, {
        completedSteps: 2,
        stage: 'index_written',
        modelCallId: call.id,
      });
      await this.jobs.complete(lease, async (ownerId, tx) => {
        await requireIndexSource(ownerId, id, tx);
        await tx
          .update(memoryVectorIndexes)
          .set({ status: 'indexed', indexedAt: new Date() })
          .where(eq(memoryVectorIndexes.id, id));
      });
    } catch (error) {
      // 迟到外部写入不能变成有效索引；清理失败仍由持久记录负责后续补偿。
      await this.vectors.remove(row.index.collection, [row.version.id]).catch(() => undefined);
      throw error;
    }
  }
  /** 幂等创建恢复任务；结果未知不重发，成功编码可复用。 */
  async retry(
    companionId: string,
    indexId: string,
    command: OrganizeMemory,
  ): Promise<{ taskId: string }> {
    const current = await this.configuration.get();
    return this.store.locked(async (ownerId, tx) => {
      const row = await requireIndexSource(ownerId, indexId, tx);
      if (
        row.entry.companionId !== companionId ||
        row.entry.runtimeEpoch !== command.runtimeEpoch ||
        row.entry.conversationId !== command.conversationId
      )
        throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      const requestKey = `index_retry:${indexId}:${command.requestId}`;
      const hash = fingerprint(command);
      const [replay] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.ownerId, ownerId), eq(tasks.requestKey, requestKey)));
      if (replay) {
        if (replay.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return { taskId: replay.id };
      }
      const [previous] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.ownerId, ownerId), eq(tasks.id, row.index.taskId)));
      if (
        !previous ||
        previous.input.kind !== 'memory_index' ||
        !['failed', 'blocked', 'cancelled', 'succeeded'].includes(previous.status)
      )
        throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
      const [call] = await tx
        .select()
        .from(modelCalls)
        .where(
          and(
            eq(modelCalls.ownerId, ownerId),
            eq(modelCalls.requestId, previous.input.modelRequestId),
          ),
        );
      if (call && ['running', 'unknown'].includes(call.status))
        throw new ApiException(API_CODES.MODEL_USAGE_UNKNOWN);
      if (row.index.space !== embeddingSpace(current.config.tasks.embedding, this.config))
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      const taskId = randomUUID();
      await tx.insert(tasks).values({
        id: taskId,
        ownerId,
        requestKey,
        fingerprint: hash,
        kind: 'memory_index',
        input: {
          kind: 'memory_index',
          indexId,
          modelRequestId: call?.status === 'succeeded' ? previous.input.modelRequestId : taskId,
        },
        scope: previous.scope,
        totalSteps: 2,
      });
      await tx
        .update(memoryVectorIndexes)
        .set({
          taskId,
          status: 'pending',
          indexedAt: null,
          configVersion: call?.status === 'succeeded' ? row.index.configVersion : current.version,
        })
        .where(eq(memoryVectorIndexes.id, indexId));
      return { taskId };
    });
  }

  /** 管理查询只显示身份与状态，正文仍从记忆查询接口读取。 */
  async list(
    companionId: string,
    runtimeEpoch: number,
    afterId?: string,
  ): Promise<RecallIndexList> {
    const configuration = await this.configuration.get();
    const space = embeddingSpace(configuration.config.tasks.embedding, this.config);
    return this.store.locked(async (ownerId, tx) => {
      await requireCompanion(ownerId, companionId, runtimeEpoch, tx);
      const rows = await tx
        .select()
        .from(memoryVectorIndexes)
        .where(
          and(
            eq(memoryVectorIndexes.ownerId, ownerId),
            eq(memoryVectorIndexes.companionId, companionId),
            eq(memoryVectorIndexes.runtimeEpoch, runtimeEpoch),
            afterId ? gt(memoryVectorIndexes.id, afterId) : undefined,
          ),
        )
        .orderBy(asc(memoryVectorIndexes.id))
        .limit(51);
      return {
        space,
        items: rows.slice(0, 50).map((row) => ({
          id: row.id,
          versionId: row.versionId,
          space: row.space,
          collection: row.collection,
          status: row.status,
          taskId: row.taskId,
          indexedAt: row.indexedAt?.toISOString() ?? null,
        })),
        nextAfterId: rows.length > 50 ? rows[49]!.id : null,
      };
    });
  }
}
