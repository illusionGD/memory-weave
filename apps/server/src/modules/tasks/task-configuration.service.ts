import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { API_CODES } from '@memory-weave/contracts';
import type {
  TaskConfiguration,
  TaskConfigurationVersion,
  UpdateTaskConfiguration,
} from '@memory-weave/contracts';
import { taskConfigurationVersions } from '../../database/schema';
import type { DatabaseTransaction } from '../../database/database.service';
import { ApiException } from '../../http/api-exception';
import { fingerprint } from '../shared/http';
import { TaskStore } from './task-store';

/** 单一默认值来源，单位与覆盖规则在 contracts 中声明。 */
export const defaultTaskConfiguration: Readonly<TaskConfiguration> = {
  enabled: true,
  maxConcurrent: 1,
  pollMs: 1000,
  leaseMs: 30000,
  attemptTimeoutMs: 180000,
  maxAttempts: 3,
  retryBaseMs: 1000,
  retryMaxMs: 60000,
  outboxBatchSize: 20,
};

/** 调度与模型配置分组管理；发布配置不修改现有任务或额度。 */
@Injectable()
export class TaskConfigurationService {
  constructor(@Inject(TaskStore) private readonly store: TaskStore) {}

  /** 读取生效配置，首次使用时持久登记默认版本。 */
  get(): Promise<TaskConfigurationVersion> {
    return this.store.locked((ownerId, tx) => this.current(ownerId, tx));
  }

  /** 历史只读，回滚应将旧配置发布为新版本。 */
  getVersion(version: number): Promise<TaskConfigurationVersion> {
    return this.store.locked(async (ownerId, tx) => {
      await this.current(ownerId, tx);
      const [row] = await tx
        .select()
        .from(taskConfigurationVersions)
        .where(
          and(
            eq(taskConfigurationVersions.ownerId, ownerId),
            eq(taskConfigurationVersions.version, version),
          ),
        );
      if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      return view(row);
    });
  }

  /** 同一短事务核对版本与幂等键，非法修改保留原配置。 */
  update(input: UpdateTaskConfiguration): Promise<TaskConfigurationVersion> {
    return this.store.locked(async (ownerId, tx, now) => {
      const current = await this.current(ownerId, tx);
      const hash = fingerprint({ expectedVersion: input.expectedVersion, config: input.config });
      const [existing] = await tx
        .select()
        .from(taskConfigurationVersions)
        .where(
          and(
            eq(taskConfigurationVersions.ownerId, ownerId),
            eq(taskConfigurationVersions.requestId, input.requestId),
          ),
        );
      if (existing) {
        if (existing.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return view(existing);
      }
      if (current.version !== input.expectedVersion)
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      if (current.version >= 2147483647) throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
      if (
        input.config.leaseMs > input.config.attemptTimeoutMs ||
        input.config.retryBaseMs > input.config.retryMaxMs
      )
        throw new ApiException(
          API_CODES.INVALID_REQUEST,
          '租约不能超过单次执行上限，退避上限不能小于起点。',
        );
      const row = {
        id: randomUUID(),
        ownerId,
        version: current.version + 1,
        source: 'deployment' as const,
        config: input.config,
        requestId: input.requestId,
        fingerprint: hash,
        createdAt: now,
      };
      await tx.insert(taskConfigurationVersions).values(row);
      return view(row);
    });
  }

  /** 必须在 TaskStore 事务中调用，确保本次决策只读取一个完整版本。 */
  async current(ownerId: string, tx: DatabaseTransaction): Promise<TaskConfigurationVersion> {
    const [row] = await tx
      .select()
      .from(taskConfigurationVersions)
      .where(eq(taskConfigurationVersions.ownerId, ownerId))
      .orderBy(desc(taskConfigurationVersions.version))
      .limit(1);
    if (row) return view(row);
    const initial = {
      id: randomUUID(),
      ownerId,
      version: 1,
      source: 'default' as const,
      config: defaultTaskConfiguration,
      requestId: randomUUID(),
      fingerprint: 'default',
      createdAt: new Date(),
    };
    await tx.insert(taskConfigurationVersions).values(initial);
    return view(initial);
  }
}

/** 不导出内部幂等摘要与部署身份。 */
function view(row: typeof taskConfigurationVersions.$inferSelect): TaskConfigurationVersion {
  return {
    version: row.version,
    source: row.source,
    config: row.config,
    createdAt: row.createdAt.toISOString(),
  };
}
