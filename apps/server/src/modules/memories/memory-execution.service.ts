import { adoptMemories } from './memory-records';
import { Inject, Injectable } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq } from 'drizzle-orm';
import { API_CODES } from '@memory-weave/contracts';
import { ApiException } from '../../http/api-exception';
import { memoryBatches, processingRanges } from '../../database/schema';
import { TaskStore } from '../tasks/task-store';
import { TasksService } from '../tasks/tasks.service';
import type { TaskLease } from '../tasks/task-types';
import { ModelRuntimeService } from '../models/model-runtime.service';
import { requireMemoryBatch } from './memory-access';
import { memoryDefinition, memoryOutputSchema } from './memory-definition';

/** 模型只提出候选，领域提交与独立进度保持同一事务。 */
@Injectable()
export class MemoryExecutionService {
  constructor(
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(TasksService) private readonly jobs: TasksService,
    @Inject(ModelRuntimeService) private readonly models: ModelRuntimeService,
  ) {}
  /** 恢复时沿用 task ID，不为未知外部结果自动换键重发。 */
  async execute(lease: TaskLease): Promise<void> {
    if (lease.input.kind !== 'memory_batch') throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
    const id = lease.input.batchId;
    const batch = await this.store.locked((ownerId, tx) => requireMemoryBatch(ownerId, id, tx));
    let call = await this.models.execute(
      {
        requestId: lease.task.id,
        expectedConfigVersion: batch.configVersion,
        role: 'memory',
        operation: 'structured',
        inputText: JSON.stringify(batch.input),
        lane: 'background',
      },
      memoryDefinition,
      lease.task.scope,
      (ownerId, tx) => this.jobs.guardDispatch(ownerId, tx, lease),
    );
    while (call.status === 'running') {
      await delay(lease.config.pollMs);
      await this.jobs.heartbeat(lease);
      call = await this.models.get(call.id);
    }
    await this.jobs.checkpoint(lease, {
      completedSteps: call.status === 'succeeded' ? 1 : 0,
      stage: 'memory_result',
      modelCallId: call.id,
    });
    if (call.status === 'unknown') {
      await this.jobs.block(lease, 'model_result_unknown');
      return;
    }
    if (call.status !== 'succeeded' || call.result?.kind !== 'structured') {
      await this.jobs.fail(lease, call.status === 'cancelled' ? 'model_cancelled' : 'model_failed');
      return;
    }
    const output = memoryOutputSchema.safeParse(call.result.value);
    if (!output.success) throw new ApiException(API_CODES.MODEL_OUTPUT_INVALID);
    await this.jobs.complete(lease, async (ownerId, tx) => {
      const current = await requireMemoryBatch(ownerId, id, tx);
      if (current.taskId !== lease.task.id || current.completedAt)
        throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
      const ranges = await tx
        .select()
        .from(processingRanges)
        .where(and(eq(processingRanges.ownerId, ownerId), eq(processingRanges.batchId, id)));
      const targets = current.input!.messages.filter((source) => source.target);
      if (
        ranges.length !== targets.length ||
        ranges.some(
          (range) =>
            range.status !== 'processing' ||
            range.companionId !== current.companionId ||
            range.runtimeEpoch !== current.runtimeEpoch ||
            !targets.some(
              (source) =>
                source.messageId === range.messageId &&
                source.contentVersion === range.contentVersion &&
                source.sequence === range.startSequence &&
                source.sequence === range.endSequence,
            ),
        )
      )
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      const outcomes = await adoptMemories(ownerId, current, output.data, tx);
      await tx
        .update(memoryBatches)
        .set({ outcomes, completedAt: new Date() })
        .where(eq(memoryBatches.id, id));
      await tx
        .update(processingRanges)
        .set({ status: 'processed' })
        .where(and(eq(processingRanges.ownerId, ownerId), eq(processingRanges.batchId, id)));
    });
  }
}
