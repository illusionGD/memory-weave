import { requireMemoryBatch } from './memory-access';
import {
  listMemoryRecords,
  memoryRecordDetail,
  memoryRecordEvidence,
  toMemoryItem,
} from './memory-records';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { API_CODES, memoryConfigurationSchema } from '@memory-weave/contracts';
import type {
  MemoryBatchList,
  MemoryBatchResult,
  MemoryQuery,
  OrganizeMemory,
  ModelConfigurationVersion,
} from '@memory-weave/contracts';
import { SERVER_CONFIG } from '../../config';
import type { RuntimeConfig } from '../../config';
import {
  memoryBatches,
  messages,
  processingRanges,
  tasks,
  companions,
  conversations,
  conversationMembers,
  memoryEntries,
  memoryVersions,
  modelCalls,
  readReceipts,
} from '../../database/schema';
import type { DatabaseTransaction } from '../../database/database.service';
import { ApiException } from '../../http/api-exception';
import { assertVisible, requireCompanionMember } from '../conversations/conversation-access';
import { fingerprint } from '../shared/http';
import { TaskStore } from '../tasks/task-store';
import { ModelConfigurationService } from '../models/model-configuration.service';
import { MEMORY_DEFINITION_VERSION } from './memory-definition';
import type { MemoryBatchInput } from './memory-types';

/** 固定批次、独立范围和管理查询；不在事务内调用模型。 */
@Injectable()
export class MemoriesService {
  constructor(
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(ModelConfigurationService) private readonly models: ModelConfigurationService,
    @Inject(SERVER_CONFIG) private readonly runtime: RuntimeConfig,
  ) {}
  /** 提前安排一个批次，同命令严格复用首次范围。 */
  async organize(companionId: string, input: OrganizeMemory): Promise<MemoryBatchResult> {
    const current = await this.activateDefinition();
    return this.store.locked(async (ownerId, tx, now) => {
      await requireCompanionMember(
        ownerId,
        companionId,
        input.runtimeEpoch,
        input.conversationId,
        tx,
      );
      const hash = fingerprint({ companionId, ...input });
      const [existing] = await tx
        .select()
        .from(memoryBatches)
        .where(
          and(eq(memoryBatches.ownerId, ownerId), eq(memoryBatches.requestId, input.requestId)),
        );
      if (existing) {
        if (existing.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return this.result(existing);
      }
      const batch = await this.createBatch(
        ownerId,
        tx,
        now,
        companionId,
        input,
        current,
        hash,
        true,
      );
      if (!batch)
        throw new ApiException(
          API_CODES.TASK_STATE_CONFLICT,
          '该伴侣有尚未完成的记忆批次，请先查看或恢复原任务。',
        );
      return this.result(batch);
    });
  }
  /** 已知失败可显式重新分批；保留旧任务，不自动重发未知模型调用。 */
  async retry(companionId: string, id: string, input: OrganizeMemory): Promise<MemoryBatchResult> {
    const current = await this.activateDefinition();
    return this.store.locked(async (ownerId, tx, now) => {
      await requireCompanionMember(
        ownerId,
        companionId,
        input.runtimeEpoch,
        input.conversationId,
        tx,
      );
      const hash = fingerprint({ companionId, retryBatchId: id, ...input });
      const [replay] = await tx
        .select()
        .from(memoryBatches)
        .where(
          and(eq(memoryBatches.ownerId, ownerId), eq(memoryBatches.requestId, input.requestId)),
        );
      if (replay) {
        if (replay.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return this.result(replay);
      }
      const previous = await requireMemoryBatch(ownerId, id, tx);
      if (
        previous.companionId !== companionId ||
        previous.runtimeEpoch !== input.runtimeEpoch ||
        previous.conversationId !== input.conversationId
      )
        throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      const [task] = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, previous.taskId ?? ''));
      const [call] = await tx
        .select()
        .from(modelCalls)
        .where(
          and(eq(modelCalls.ownerId, ownerId), eq(modelCalls.requestId, previous.taskId ?? '')),
        );
      if (
        previous.completedAt ||
        !task ||
        !['failed', 'cancelled', 'blocked'].includes(task.status) ||
        call?.status === 'unknown' ||
        call?.status === 'running'
      )
        throw new ApiException(
          API_CODES.TASK_STATE_CONFLICT,
          '原批次仍在执行或外部结果未确定，不能重发。',
        );
      await tx.update(memoryBatches).set({ completedAt: now }).where(eq(memoryBatches.id, id));
      await tx
        .update(processingRanges)
        .set({ status: 'pending', batchId: null })
        .where(
          and(
            eq(processingRanges.ownerId, ownerId),
            eq(processingRanges.batchId, id),
            eq(processingRanges.status, 'processing'),
          ),
        );
      const batch = await this.createBatch(
        ownerId,
        tx,
        now,
        companionId,
        input,
        current,
        hash,
        true,
      );
      if (!batch) throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
      return this.result(batch);
    });
  }
  /** 持久范围决定待办，定时器仅唤醒；每轮最多检查十个有资格的会话。 */
  async schedule(): Promise<void> {
    const config = memoryConfigurationSchema.parse(this.runtime.memoryConfiguration ?? {});
    if (!config.enabled) return;
    const current = await this.models.get();
    await this.store.locked(async (ownerId, tx, now) => {
      const groups = await tx
        .select({
          companionId: processingRanges.companionId,
          runtimeEpoch: processingRanges.runtimeEpoch,
          conversationId: processingRanges.conversationId,
          oldest: sql<Date>`MIN(${processingRanges.createdAt})`,
        })
        .from(processingRanges)
        .innerJoin(
          companions,
          and(
            eq(companions.id, processingRanges.companionId),
            eq(companions.runtimeEpoch, processingRanges.runtimeEpoch),
            isNull(companions.deletedAt),
            isNull(companions.lifecycleOperationId),
          ),
        )
        .innerJoin(
          conversations,
          and(
            eq(conversations.id, processingRanges.conversationId),
            isNull(conversations.lifecycleOperationId),
          ),
        )
        .where(
          and(
            eq(processingRanges.ownerId, ownerId),
            eq(processingRanges.status, 'pending'),
            sql`NOT EXISTS (SELECT 1 FROM memory_batches mb WHERE mb.owner_id = ${ownerId} AND mb.companion_id = ${processingRanges.companionId} AND mb.runtime_epoch = ${processingRanges.runtimeEpoch} AND mb.completed_at IS NULL)`,
          ),
        )
        .groupBy(
          processingRanges.companionId,
          processingRanges.runtimeEpoch,
          processingRanges.conversationId,
        )
        .orderBy(sql`MIN(${processingRanges.createdAt})`)
        .limit(10);
      for (const group of groups) {
        try {
          await this.createBatch(
            ownerId,
            tx,
            now,
            group.companionId,
            {
              requestId: randomUUID(),
              runtimeEpoch: group.runtimeEpoch,
              conversationId: group.conversationId,
            },
            current,
            'automatic',
            false,
          );
        } catch (error) {
          if (
            !(error instanceof ApiException) ||
            ![
              API_CODES.RESOURCE_NOT_FOUND,
              API_CODES.RUNTIME_EPOCH_MISMATCH,
              API_CODES.LIFECYCLE_RESTRICTED,
            ].some((code) => code === error.code)
          )
            throw error;
        }
      }
    });
  }
  /** 查询当前会话的记忆，不隐式推进读取或整理进度。 */
  list(companionId: string, query: MemoryQuery) {
    return this.store.locked(async (ownerId, tx) => {
      await requireCompanionMember(
        ownerId,
        companionId,
        query.runtimeEpoch,
        query.conversationId,
        tx,
      );
      return listMemoryRecords(ownerId, companionId, query, tx);
    });
  }
  /** 回查当前及历史版本的精确来源。 */
  detail(companionId: string, id: string, query: MemoryQuery) {
    return this.store.locked(async (ownerId, tx) => {
      await requireCompanionMember(
        ownerId,
        companionId,
        query.runtimeEpoch,
        query.conversationId,
        tx,
      );
      return memoryRecordDetail(ownerId, companionId, id, query, tx);
    });
  }
  /** 单个版本的证据也保持有界分页。 */
  evidence(companionId: string, id: string, versionId: string, query: MemoryQuery) {
    return this.store.locked(async (ownerId, tx) => {
      await requireCompanionMember(
        ownerId,
        companionId,
        query.runtimeEpoch,
        query.conversationId,
        tx,
      );
      return memoryRecordEvidence(ownerId, companionId, id, versionId, query, tx);
    });
  }
  /** 失败和阻塞保持可见；无候选也能显示成功。 */
  batches(companionId: string, query: MemoryQuery): Promise<MemoryBatchList> {
    return this.store.locked(async (ownerId, tx) => {
      await requireCompanionMember(
        ownerId,
        companionId,
        query.runtimeEpoch,
        query.conversationId,
        tx,
      );
      const rows = await tx
        .select({ batch: memoryBatches, task: tasks })
        .from(memoryBatches)
        .leftJoin(tasks, eq(tasks.id, memoryBatches.taskId))
        .where(
          and(
            eq(memoryBatches.ownerId, ownerId),
            eq(memoryBatches.companionId, companionId),
            eq(memoryBatches.runtimeEpoch, query.runtimeEpoch),
            eq(memoryBatches.conversationId, query.conversationId),
            query.afterId ? gt(memoryBatches.id, query.afterId) : undefined,
          ),
        )
        .orderBy(asc(memoryBatches.id))
        .limit(query.limit + 1);
      return {
        items: rows.slice(0, query.limit).map(({ batch, task }) => ({
          ...this.result(batch),
          status: task?.status ?? 'succeeded',
          reason: task?.reason ?? null,
          sequences: batch.sequences,
          configVersion: batch.configVersion,
          mode: batch.mode,
          outcomes: batch.outcomes,
          createdAt: batch.createdAt.toISOString(),
          completedAt: batch.completedAt?.toISOString() ?? null,
        })),
        nextAfterId: rows.length > query.limit ? rows[query.limit - 1]!.batch.id : null,
        configuration: memoryConfigurationSchema.parse(this.runtime.memoryConfiguration ?? {}),
      };
    });
  }
  private result(batch: typeof memoryBatches.$inferSelect): MemoryBatchResult {
    return { id: batch.id, taskId: batch.taskId, sourceCount: batch.sequences.length };
  }
  private async createBatch(
    ownerId: string,
    tx: DatabaseTransaction,
    now: Date,
    companionId: string,
    command: OrganizeMemory,
    current: ModelConfigurationVersion,
    hash: string,
    force: boolean,
  ) {
    const config = memoryConfigurationSchema.parse(this.runtime.memoryConfiguration ?? {});
    const member = await requireCompanionMember(
      ownerId,
      companionId,
      command.runtimeEpoch,
      command.conversationId,
      tx,
    );
    const [active] = await tx
      .select({ id: memoryBatches.id })
      .from(memoryBatches)
      .where(
        and(
          eq(memoryBatches.ownerId, ownerId),
          eq(memoryBatches.companionId, companionId),
          eq(memoryBatches.runtimeEpoch, command.runtimeEpoch),
          isNull(memoryBatches.completedAt),
        ),
      )
      .limit(1);
    if (active) return null;
    const ranges = await tx
      .select({ range: processingRanges, message: messages, speaker: conversationMembers })
      .from(processingRanges)
      .innerJoin(
        messages,
        and(
          eq(messages.id, processingRanges.messageId),
          eq(messages.contentVersion, processingRanges.contentVersion),
          eq(messages.state, 'published'),
          isNull(messages.deletedAt),
        ),
      )
      .innerJoin(conversationMembers, eq(conversationMembers.id, messages.speakerMembershipId))
      .where(
        and(
          eq(processingRanges.ownerId, ownerId),
          eq(processingRanges.companionId, companionId),
          eq(processingRanges.runtimeEpoch, command.runtimeEpoch),
          eq(processingRanges.conversationId, command.conversationId),
          eq(processingRanges.status, 'pending'),
        ),
      )
      .orderBy(asc(processingRanges.startSequence))
      .limit(config.maxMessages);
    if (!force && !ranges.length) return null;
    const [latest] = await tx
      .select({ publishedAt: messages.publishedAt })
      .from(messages)
      .where(
        and(
          eq(messages.ownerId, ownerId),
          eq(messages.conversationId, command.conversationId),
          eq(messages.state, 'published'),
          isNull(messages.deletedAt),
        ),
      )
      .orderBy(desc(messages.sequence))
      .limit(1);
    const totalCharacters = ranges.reduce((sum, row) => sum + row.message.text.length, 0);
    if (
      !force &&
      ranges.length < Math.min(config.messageThreshold, config.maxMessages) &&
      totalCharacters < config.characterThreshold &&
      now.getTime() - (latest?.publishedAt?.getTime() ?? now.getTime()) < config.idleMs &&
      now.getTime() - ranges[0]!.range.createdAt.getTime() < config.maxWaitMs
    )
      return null;
    const input: MemoryBatchInput = {
      companionId,
      permissionVersion: member.permissionVersion,
      messages: [],
      related: [],
    };
    const selected: typeof ranges = [];
    for (const row of ranges) {
      await assertVisible(member, row.range.startSequence, tx);
      const source = {
        messageId: row.message.id,
        contentVersion: row.message.contentVersion,
        sequence: row.range.startSequence,
        text: row.message.text,
        speaker: { kind: row.speaker.kind, id: row.speaker.companionId ?? row.speaker.userId! },
        publishedAt: row.message.publishedAt!.toISOString(),
        target: true,
        reality: row.message.reality,
        epistemic: row.message.epistemicKind,
        sourceKind: row.message.sourceKind,
        occurredAt: row.message.occurredAt?.toISOString() ?? null,
        validFrom: row.message.validFrom?.toISOString() ?? null,
        validUntil: row.message.validUntil?.toISOString() ?? null,
      };
      input.messages.push(source);
      if (selected.length && JSON.stringify(input).length > config.maxInputCharacters) {
        input.messages.pop();
        break;
      }
      selected.push(row);
    }
    if (selected.length) {
      const context = await tx
        .select({ message: messages, speaker: conversationMembers })
        .from(messages)
        .innerJoin(conversationMembers, eq(conversationMembers.id, messages.speakerMembershipId))
        .where(
          and(
            eq(messages.ownerId, ownerId),
            eq(messages.conversationId, command.conversationId),
            eq(messages.state, 'published'),
            isNull(messages.deletedAt),
            lt(messages.sequence, selected[0]!.range.startSequence),
          ),
        )
        .orderBy(desc(messages.sequence))
        .limit(config.contextMessages);
      for (const row of context) {
        try {
          await assertVisible(member, row.message.sequence!, tx);
        } catch (error) {
          if (error instanceof ApiException && error.code === API_CODES.RESOURCE_NOT_FOUND)
            continue;
          throw error;
        }
        const source = {
          messageId: row.message.id,
          contentVersion: row.message.contentVersion,
          sequence: row.message.sequence!,
          text: row.message.text,
          speaker: { kind: row.speaker.kind, id: row.speaker.companionId ?? row.speaker.userId! },
          publishedAt: row.message.publishedAt!.toISOString(),
          target: false,
          reality: row.message.reality,
          epistemic: row.message.epistemicKind,
          sourceKind: row.message.sourceKind,
          occurredAt: row.message.occurredAt?.toISOString() ?? null,
          validFrom: row.message.validFrom?.toISOString() ?? null,
          validUntil: row.message.validUntil?.toISOString() ?? null,
        };
        input.messages.unshift(source);
        if (JSON.stringify(input).length > config.maxInputCharacters) {
          input.messages.shift();
          break;
        }
      }
      const related = await tx
        .select({ entry: memoryEntries, version: memoryVersions })
        .from(memoryEntries)
        .innerJoin(memoryVersions, eq(memoryVersions.id, memoryEntries.currentVersionId))
        .where(
          and(
            eq(memoryEntries.ownerId, ownerId),
            eq(memoryEntries.companionId, companionId),
            eq(memoryEntries.runtimeEpoch, command.runtimeEpoch),
            eq(memoryEntries.conversationId, command.conversationId),
            isNull(memoryVersions.invalidatedAt),
          ),
        )
        .orderBy(desc(memoryVersions.createdAt), desc(memoryEntries.id))
        .limit(config.relatedMemories);
      for (const row of related) {
        await memoryRecordDetail(
          ownerId,
          companionId,
          row.entry.id,
          { runtimeEpoch: command.runtimeEpoch, conversationId: command.conversationId, limit: 1 },
          tx,
        );
        input.related.push(toMemoryItem(row.entry, row.version));
        if (JSON.stringify(input).length > config.maxInputCharacters) {
          input.related.pop();
          break;
        }
      }
    }
    const id = randomUUID();
    const taskId = selected.length ? randomUUID() : null;
    const configured =
      current.config.tasks.memory.promptVersion === MEMORY_DEFINITION_VERSION &&
      current.config.tasks.memory.schemaVersion === MEMORY_DEFINITION_VERSION &&
      current.config.tasks.memory.preprocessingVersion === 'utf8-v1';
    const reason = !configured
      ? 'memory_configuration_required'
      : JSON.stringify(input).length > config.maxInputCharacters
        ? 'memory_input_too_large'
        : null;
    const row = {
      id,
      ownerId,
      companionId,
      runtimeEpoch: command.runtimeEpoch,
      conversationId: command.conversationId,
      requestId: command.requestId,
      fingerprint: hash,
      taskId,
      input,
      configuration: config,
      configVersion: current.version,
      mode:
        current.config.tasks.memory.providerId === 'test' ? ('test' as const) : ('model' as const),
      sequences: selected.map((r) => r.range.startSequence),
      outcomes: taskId ? null : { add: 0, merge: 0, revise: 0, conflict: 0, defer: 0 },
      createdAt: now,
      completedAt: taskId ? null : now,
    };
    await tx.insert(memoryBatches).values(row);
    if (taskId) {
      const taskInput = { kind: 'memory_batch' as const, batchId: id };
      const scope = {
        companionId,
        runtimeEpoch: command.runtimeEpoch,
        conversationId: command.conversationId,
      };
      await tx.insert(tasks).values({
        id: taskId,
        ownerId,
        requestKey: `memory-batch:${id}`,
        fingerprint: fingerprint({ input: taskInput, scope }),
        kind: 'memory_extraction',
        input: taskInput,
        scope,
        status: reason ? 'blocked' : 'queued',
        reason,
        stage: 'memory_batch',
        totalSteps: 1,
        createdAt: now,
        updatedAt: now,
        availableAt: now,
      });
      await tx
        .insert(readReceipts)
        .values(
          input.messages.map((source) => ({
            ownerId,
            companionId,
            runtimeEpoch: command.runtimeEpoch,
            conversationId: command.conversationId,
            messageId: source.messageId,
            contentVersion: source.contentVersion,
            startOffset: 0,
            endOffset: source.text.length,
          })),
        )
        .onDuplicateKeyUpdate({ set: { id: sql`${readReceipts.id}` } });
      await tx
        .update(processingRanges)
        .set({ status: 'processing', batchId: id })
        .where(
          inArray(
            processingRanges.id,
            selected.map((r) => r.range.id),
          ),
        );
    }
    return row;
  }
  /** 首次显式唤醒可升级旧占位定义，不更换模型、价格或预算。 */
  private async activateDefinition(): Promise<ModelConfigurationVersion> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.models.get();
      const role = current.config.tasks.memory;
      if (
        role.promptVersion === MEMORY_DEFINITION_VERSION &&
        role.schemaVersion === MEMORY_DEFINITION_VERSION &&
        role.preprocessingVersion === 'utf8-v1'
      )
        return current;
      if (
        role.promptVersion !== 'probe-v1' ||
        role.schemaVersion !== 'probe-v1' ||
        role.preprocessingVersion !== 'utf8-v1'
      )
        throw new ApiException(API_CODES.MODEL_NOT_CONFIGURED);
      try {
        return await this.models.update({
          requestId: randomUUID(),
          expectedVersion: current.version,
          config: {
            ...current.config,
            tasks: {
              ...current.config.tasks,
              memory: {
                ...role,
                promptVersion: MEMORY_DEFINITION_VERSION,
                schemaVersion: MEMORY_DEFINITION_VERSION,
              },
            },
          },
          evaluationNote: 'F08 启用记忆批量整理定义；保留供应商、模型、价格和预算。',
        });
      } catch (error) {
        if (!(error instanceof ApiException) || error.code !== API_CODES.VERSION_CONFLICT)
          throw error;
      }
    }
    throw new ApiException(API_CODES.VERSION_CONFLICT);
  }
}
