import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { API_CODES } from '@memory-weave/contracts';
import { companions, conversations, lifecycleOperations, tasks } from '../../database/schema';
import { SERVER_CONFIG } from '../../config';
import type { RuntimeConfig } from '../../config';
import { ApiException } from '../../http/api-exception';
import { ModelConfigurationService } from '../models/model-configuration.service';
import { TasksService } from '../tasks/tasks.service';
import type { TaskLease } from '../tasks/task-types';
import { cleanupLifecyclePage, lifecycleStages } from './lifecycle-cleanup';

/** 分批清理与进度同事务提交，重启后从已提交阶段继续。 */
@Injectable()
export class LifecycleExecutionService {
  constructor(
    @Inject(ModelConfigurationService) private readonly models: ModelConfigurationService,
    @Inject(TasksService) private readonly jobs: TasksService,
    @Inject(SERVER_CONFIG) private readonly config: RuntimeConfig,
  ) {}
  /** 仅清理数据库拥有的数据；全局用量与必要核对身份不删除。 */
  async execute(lease: TaskLease): Promise<void> {
    if (lease.input.kind !== 'lifecycle_cleanup')
      throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
    const operationId = lease.input.operationId;
    while (true) {
      const done = await this.models.locked(async (ownerId, tx) => {
        await this.jobs.guardDispatch(ownerId, tx, lease);
        const [operation] = await tx
          .select()
          .from(lifecycleOperations)
          .where(
            and(eq(lifecycleOperations.ownerId, ownerId), eq(lifecycleOperations.id, operationId)),
          );
        if (!operation) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
        if (operation.taskId !== lease.task.id) throw new ApiException(API_CODES.TASK_LEASE_LOST);
        const stages = lifecycleStages(operation.protocolVersion);
        if (operation.stage >= stages.length) return true;
        const result = await cleanupLifecyclePage(
          ownerId,
          tx,
          operation,
          this.config.lifecycleBatchSize ?? 100,
        );
        const stage = operation.stage + (result.done ? 1 : 0);
        await tx
          .update(lifecycleOperations)
          .set({ stage, processedRecords: operation.processedRecords + result.changed })
          .where(eq(lifecycleOperations.id, operation.id));
        await tx
          .update(tasks)
          .set({
            completedSteps: stage,
            stage: stages[stage] ?? 'cleanup_complete',
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, lease.task.id));
        await this.jobs.guardDispatch(ownerId, tx, lease);
        return stage >= stages.length;
      });
      if (done) break;
    }
    await this.jobs.complete(lease, async (ownerId, tx) => {
      await tx
        .update(lifecycleOperations)
        .set({ completedAt: new Date() })
        .where(
          and(eq(lifecycleOperations.ownerId, ownerId), eq(lifecycleOperations.id, operationId)),
        );
      await tx
        .update(companions)
        .set({ lifecycleOperationId: null })
        .where(
          and(eq(companions.ownerId, ownerId), eq(companions.lifecycleOperationId, operationId)),
        );
      await tx
        .update(conversations)
        .set({ lifecycleOperationId: null })
        .where(
          and(
            eq(conversations.ownerId, ownerId),
            eq(conversations.lifecycleOperationId, operationId),
          ),
        );
    });
  }
}
