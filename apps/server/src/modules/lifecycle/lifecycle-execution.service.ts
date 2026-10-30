import { AvatarFiles } from '../companions/avatar-files';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { API_CODES } from '@memory-weave/contracts';
import {
  companions,
  conversations,
  lifecycleOperations,
  tasks,
  memoryVectorIndexes,
} from '../../database/schema';
import { SERVER_CONFIG } from '../../config';
import type { RuntimeConfig } from '../../config';
import { ApiException } from '../../http/api-exception';
import { ModelConfigurationService } from '../models/model-configuration.service';
import { TasksService } from '../tasks/tasks.service';
import type { TaskLease } from '../tasks/task-types';
import { cleanupLifecyclePage, lifecycleStages } from './lifecycle-cleanup';
import { vectorCleanupRows } from '../retrieval/retrieval-cleanup';
import { RetrievalVector } from '../retrieval/retrieval-vector';

/** 分批清理与进度同事务提交，重启后从已提交阶段继续。 */
@Injectable()
export class LifecycleExecutionService {
  constructor(
    @Inject(AvatarFiles) private readonly avatarFiles: AvatarFiles,
    @Inject(RetrievalVector) private readonly vectors: RetrievalVector,
    @Inject(ModelConfigurationService) private readonly models: ModelConfigurationService,
    @Inject(TasksService) private readonly jobs: TasksService,
    @Inject(SERVER_CONFIG) private readonly config: RuntimeConfig,
  ) {}
  /** 仅清理当前部署拥有的数据；全局用量与必要核对身份不删除。 */
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
        if (stages[operation.stage] === 'avatar_files')
          return { kind: 'avatar' as const, operation, ownerId };
        if (stages[operation.stage] === 'vector_points') {
          const rows = await vectorCleanupRows(
            ownerId,
            tx,
            operation,
            this.config.lifecycleBatchSize ?? 100,
          );
          if (rows.length) return { kind: 'vectors' as const, operation, rows };
          await tx
            .update(lifecycleOperations)
            .set({ stage: operation.stage + 1 })
            .where(eq(lifecycleOperations.id, operation.id));
          await tx
            .update(tasks)
            .set({
              completedSteps: operation.stage + 1,
              stage: stages[operation.stage + 1]!,
              updatedAt: new Date(),
            })
            .where(eq(tasks.id, lease.task.id));
          return false;
        }
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
      if (typeof done === 'object' && done.kind === 'avatar') {
        // 删除限制已持久生效；文件操作在事务外，重复删除同一目录安全。
        if (done.operation.kind === 'delete_companion' && done.operation.companionId)
          await this.avatarFiles.removeAll(done.ownerId, done.operation.companionId);
        await this.models.locked(async (ownerId, tx) => {
          await this.jobs.guardDispatch(ownerId, tx, lease);
          const [operation] = await tx
            .select()
            .from(lifecycleOperations)
            .where(
              and(
                eq(lifecycleOperations.ownerId, ownerId),
                eq(lifecycleOperations.id, operationId),
              ),
            );
          if (operation?.taskId !== lease.task.id || operation.stage !== done.operation.stage)
            throw new ApiException(API_CODES.TASK_LEASE_LOST);
          if (operation.kind === 'delete_companion' && operation.companionId)
            await tx
              .update(companions)
              .set({ avatar: null })
              .where(
                and(eq(companions.ownerId, ownerId), eq(companions.id, operation.companionId)),
              );
          await tx
            .update(lifecycleOperations)
            .set({ stage: operation.stage + 1 })
            .where(eq(lifecycleOperations.id, operationId));
          await tx
            .update(tasks)
            .set({
              completedSteps: operation.stage + 1,
              stage: 'cleanup_complete',
              updatedAt: new Date(),
            })
            .where(eq(tasks.id, lease.task.id));
        });
      } else if (typeof done === 'object') {
        const groups = new Map<string, string[]>();
        for (const row of done.rows) {
          const ids = groups.get(row.collection) ?? [];
          ids.push(row.versionId);
          groups.set(row.collection, ids);
        }
        for (const [collection, ids] of groups) await this.vectors.remove(collection, ids);
        await this.models.locked(async (ownerId, tx) => {
          await this.jobs.guardDispatch(ownerId, tx, lease);
          const [operation] = await tx
            .select()
            .from(lifecycleOperations)
            .where(
              and(
                eq(lifecycleOperations.ownerId, ownerId),
                eq(lifecycleOperations.id, operationId),
              ),
            );
          if (operation?.taskId !== lease.task.id || operation.stage !== done.operation.stage)
            throw new ApiException(API_CODES.TASK_LEASE_LOST);
          await tx
            .update(memoryVectorIndexes)
            .set({ status: 'deleted', reconciledAt: new Date() })
            .where(
              inArray(
                memoryVectorIndexes.id,
                done.rows.map((row) => row.id),
              ),
            );
          await tx
            .update(lifecycleOperations)
            .set({ processedRecords: operation.processedRecords + done.rows.length })
            .where(eq(lifecycleOperations.id, operationId));
        });
      } else if (done) break;
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
