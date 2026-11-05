import { DatabaseService } from '../../database/database.service';
import type { OrganizeMemory, RecallIndexList } from '@memory-weave/contracts';
import { API_CODES, retrievalConfigurationSchema } from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RuntimeConfig } from '../../config';
import { SERVER_CONFIG } from '../../config';
import {
  memoryEntries,
  memorySearchDocuments,
  memoryVectorIndexes,
  memoryVersions,
  tasks,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { requireCompanion } from '../conversations/conversation-access';
import { ModelConfigurationService } from '../models/model-configuration.service';
import { ModelRuntimeService } from '../models/model-runtime.service';
import { fingerprint } from '../shared/http';
import { TaskStore } from '../tasks/task-store';
import type { TaskLease } from '../tasks/task-types';
import { TasksService } from '../tasks/tasks.service';
import { requireIndexSource } from './retrieval-index-access';
import { registerSearchDocument } from './retrieval-lexical';
import {
  embeddingDefinition,
  embeddingSpace,
  RetrievalVector,
  vectorCollection,
} from './retrieval-vector';

/** 领域提交登记文档，worker 按当前编码空间补建任务，失败不改变正文或整理进度。 */
@Injectable()
export class RetrievalIndexService {
  /** 初始化记忆索引调度与执行服务。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(TasksService) private readonly jobs: TasksService,
    @Inject(ModelConfigurationService) private readonly configuration: ModelConfigurationService,
    @Inject(ModelRuntimeService) private readonly models: ModelRuntimeService,
    @Inject(RetrievalVector) private readonly vectors: RetrievalVector,
    @Inject(SERVER_CONFIG) private readonly config: RuntimeConfig,
  ) {}
  /**
   * 扫描记忆版本并安排词法和向量索引任务。
   *
   * 有界补齐旧版本词项和新编码空间待办，空轮询不发模型。
   */
  async schedule(ownerId: string): Promise<void> {
    const limits = this.config.retrievalConfiguration ?? retrievalConfigurationSchema.parse({});
    const configuration = await this.configuration.get(ownerId);
    const embedding = configuration.config.tasks.embedding;
    const space = embeddingSpace(embedding, this.config);
    await this.reconcileDeleted(ownerId, limits.indexBatchSize);
    await this.store.locked(ownerId, async (tx) => {
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
            this.database,
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
        await this.database.tasks.insert(
          ownerId,
          {
            id: taskId,
            requestKey: `memory_index:${id}`,
            fingerprint: fingerprint({ space, versionId: row.version.id }),
            kind: 'memory_index',
            input: { kind: 'memory_index', indexId: id, modelRequestId: taskId },
            scope,
            totalSteps: 2,
          },
          tx,
        );
        await this.database.memoryVectorIndexes.insert(
          ownerId,
          {
            id,
            versionId: row.version.id,
            memoryId: row.entry.id,
            ...scope,
            space,
            collection: vectorCollection(ownerId, space),
            configVersion: configuration.version,
            taskId,
          },
          tx,
        );
      }
    });
  }
  /** 删除过期向量点并复查已失效的索引。 */
  private async reconcileDeleted(ownerId: string, limit: number): Promise<void> {
    const rows = await this.store.locked(ownerId, (tx) =>
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
      await this.store.locked(ownerId, async (tx) => {
        await this.database.memoryVectorIndexes.update(
          ownerId,
          index.id,
          { status: 'deleted', reconciledAt: new Date() },
          tx,
        );
      });
    }
  }
  /**
   * 执行记忆编码和向量索引写入任务。
   *
   * 模型成功结果可复用；Qdrant 重试只覆盖相同点，不重复生成记忆。
   */
  async execute(lease: TaskLease): Promise<void> {
    const ownerId = lease.ownerId;
    if (lease.input.kind !== 'memory_index') throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
    const id = lease.input.indexId;
    const row = await this.store.locked(ownerId, (tx) =>
      requireIndexSource(this.database, ownerId, id, tx),
    );
    const configuration = await this.configuration.getVersion(ownerId, row.index.configVersion);
    const definition = embeddingDefinition(configuration.config.tasks.embedding);
    let call = await this.models.execute(
      ownerId,
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
      call = await this.models.get(ownerId, call.id);
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
    await this.store.locked(ownerId, (tx) => this.jobs.guardDispatch(ownerId, tx, lease));
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
        await requireIndexSource(this.database, ownerId, id, tx);
        await this.database.memoryVectorIndexes.update(
          ownerId,
          id,
          { status: 'indexed', indexedAt: new Date() },
          tx,
        );
      });
    } catch (error) {
      // 迟到外部写入不能变成有效索引；清理失败仍由持久记录负责后续补偿。
      await this.vectors.remove(row.index.collection, [row.version.id]).catch(() => undefined);
      throw error;
    }
  }
  /**
   * 重试向量索引任务或重建已有索引点。
   *
   * 幂等创建恢复任务；结果未知不重发，成功编码可复用。
   */
  async retry(
    ownerId: string,
    companionId: string,
    indexId: string,
    command: OrganizeMemory,
  ): Promise<{ taskId: string }> {
    const current = await this.configuration.get(ownerId);
    return this.store.locked(ownerId, async (tx) => {
      const row = await requireIndexSource(this.database, ownerId, indexId, tx);
      if (
        row.entry.companionId !== companionId ||
        row.entry.runtimeEpoch !== command.runtimeEpoch ||
        row.entry.conversationId !== command.conversationId
      )
        throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      const requestKey = `index_retry:${indexId}:${command.requestId}`;
      const hash = fingerprint(command);
      const replay = await this.database.tasks.findOne(ownerId, { where: { requestKey } }, tx);
      if (replay) {
        if (replay.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return { taskId: replay.id };
      }
      const previous = await this.database.tasks.findById(ownerId, row.index.taskId, tx);
      if (
        !previous ||
        previous.input.kind !== 'memory_index' ||
        !['failed', 'blocked', 'cancelled', 'succeeded'].includes(previous.status)
      )
        throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
      const call = await this.database.modelCalls.findOne(
        ownerId,
        {
          where: { requestId: previous.input.modelRequestId },
        },
        tx,
      );
      if (call && ['running', 'unknown'].includes(call.status))
        throw new ApiException(API_CODES.MODEL_USAGE_UNKNOWN);
      if (row.index.space !== embeddingSpace(current.config.tasks.embedding, this.config))
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      const taskId = randomUUID();
      await this.database.tasks.insert(
        ownerId,
        {
          id: taskId,
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
        },
        tx,
      );
      await this.database.memoryVectorIndexes.update(
        ownerId,
        indexId,
        {
          taskId,
          status: 'pending',
          indexedAt: null,
          configVersion: call?.status === 'succeeded' ? row.index.configVersion : current.version,
        },
        tx,
      );
      return { taskId };
    });
  }

  /**
   * 分页查询当前编码空间的索引记录。
   *
   * 管理查询只显示身份与状态，正文仍从记忆查询接口读取。
   */
  async list(
    ownerId: string,
    companionId: string,
    runtimeEpoch: number,
    afterId?: string,
  ): Promise<RecallIndexList> {
    const configuration = await this.configuration.get(ownerId);
    const space = embeddingSpace(configuration.config.tasks.embedding, this.config);
    return this.store.locked(ownerId, async (tx) => {
      await requireCompanion(this.database, ownerId, companionId, runtimeEpoch, tx);
      const rows = await this.database.memoryVectorIndexes.findMany(
        ownerId,
        {
          where: and(
            eq(memoryVectorIndexes.companionId, companionId),
            eq(memoryVectorIndexes.runtimeEpoch, runtimeEpoch),
            afterId ? gt(memoryVectorIndexes.id, afterId) : undefined,
          ),
          orderBy: [asc(memoryVectorIndexes.id)],
          limit: 51,
        },
        tx,
      );
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
