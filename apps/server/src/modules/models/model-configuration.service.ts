import { API_CODES, MODEL_TASK_ROLES } from '@memory-weave/contracts';
import type {
  ModelConfiguration,
  ModelConfigurationVersion,
  UpdateModelConfiguration,
} from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import { modelConfigurationHeads, modelConfigurationVersions } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { fingerprint } from '../shared/http';
import { defaultModelConfiguration } from './model-defaults';
import { ModelProvidersService } from './model-providers.service';

/** 集中配置按部署发布完整版本，行锁与后续预算预留共用。 */
@Injectable()
export class ModelConfigurationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ModelProvidersService) private readonly providers: ModelProvidersService,
  ) {}

  /** 当前有效配置；首次访问持久登记默认版本。 */
  get(): Promise<ModelConfigurationVersion> {
    return this.locked(async (_ownerId, _tx, current) => current);
  }

  /** 读取不可变历史，用于比较或作为新版本回滚的输入。 */
  getVersion(version: number): Promise<ModelConfigurationVersion> {
    return this.database.withOwner(async (ownerId, db) => {
      const [row] = await db
        .select()
        .from(modelConfigurationVersions)
        .where(
          and(
            eq(modelConfigurationVersions.ownerId, ownerId),
            eq(modelConfigurationVersions.version, version),
          ),
        );
      if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      return toVersion(row);
    });
  }

  /** 发布配置前检查版本与各字段关系；计量记录不在配置表中。 */
  update(input: UpdateModelConfiguration): Promise<ModelConfigurationVersion> {
    const hash = fingerprint({ ...input, requestId: input.requestId.toLowerCase() });
    return this.locked(async (ownerId, tx, current) => {
      const [replay] = await tx
        .select()
        .from(modelConfigurationVersions)
        .where(
          and(
            eq(modelConfigurationVersions.ownerId, ownerId),
            eq(modelConfigurationVersions.requestId, input.requestId),
          ),
        );
      if (replay) {
        if (replay.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return toVersion(replay);
      }
      if (current.version !== input.expectedVersion)
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      if (current.version >= 2_147_483_647) throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
      validateConfiguration(input.config);
      this.providers.validate(input.config);
      const row = {
        id: randomUUID(),
        ownerId,
        version: current.version + 1,
        source: 'deployment' as const,
        config: input.config,
        evaluationNote: input.evaluationNote,
        requestId: input.requestId,
        fingerprint: hash,
        createdAt: new Date(),
      };
      await tx.insert(modelConfigurationVersions).values(row);
      await tx
        .update(modelConfigurationHeads)
        .set({ activeVersion: row.version })
        .where(eq(modelConfigurationHeads.ownerId, ownerId));
      return toVersion(row);
    });
  }

  /**
   * 在短事务中串行执行与配置和额度相关的操作；禁止在回调内调用外部模型。
   * @param operation 只读写本部署数据的事务操作。
   * @returns 当前配置版本下完成的操作结果。
   */
  locked<T>(
    operation: (
      ownerId: string,
      tx: DatabaseTransaction,
      current: ModelConfigurationVersion,
    ) => Promise<T>,
  ): Promise<T> {
    return this.database.withOwner((ownerId, db) =>
      db.transaction(
        async (tx) => {
          await tx
            .insert(modelConfigurationHeads)
            .values({ ownerId, activeVersion: 0 })
            .onDuplicateKeyUpdate({ set: { ownerId } });
          const [head] = await tx
            .select()
            .from(modelConfigurationHeads)
            .where(eq(modelConfigurationHeads.ownerId, ownerId))
            .for('update');
          if (!head) throw new ApiException(API_CODES.DATA_UNAVAILABLE);
          if (head.activeVersion === 0) {
            const row = {
              id: randomUUID(),
              ownerId,
              version: 1,
              source: 'default' as const,
              config: this.providers.effective(defaultModelConfiguration()),
              evaluationNote: '确定性测试配置，未连接真实模型。',
              requestId: randomUUID(),
              fingerprint: 'default',
              createdAt: new Date(),
            };
            await tx.insert(modelConfigurationVersions).values(row);
            await tx
              .update(modelConfigurationHeads)
              .set({ activeVersion: 1 })
              .where(eq(modelConfigurationHeads.ownerId, ownerId));
            return operation(ownerId, tx, toVersion(row));
          }
          const [row] = await tx
            .select()
            .from(modelConfigurationVersions)
            .where(
              and(
                eq(modelConfigurationVersions.ownerId, ownerId),
                eq(modelConfigurationVersions.version, head.activeVersion),
              ),
            );
          if (!row) throw new ApiException(API_CODES.DATA_UNAVAILABLE);
          return operation(ownerId, tx, toVersion(row));
        },
        { isolationLevel: 'read committed' },
      ),
    );
  }
}

/** 当前支持的用途和参数关系，不把可解析的 JSON 当成有效配置。 */
function validateConfiguration(config: ModelConfiguration): void {
  if (config.backgroundConcurrent >= config.maxConcurrent)
    throw new ApiException(API_CODES.INVALID_REQUEST, '后台并发必须小于总并发，为交互保留容量。');
  for (const role of MODEL_TASK_ROLES) {
    const task = config.tasks[role];
    if (
      role === 'embedding'
        ? task.dimensions === null || task.maxOutputTokens !== 0
        : task.dimensions !== null || task.maxOutputTokens === 0
    ) {
      throw new ApiException(API_CODES.INVALID_REQUEST, '任务类型与向量维度或输出上限不匹配。');
    }
  }
}

/** 不向终端暴露内部幂等指纹、owner 或数据库行格式。 */
function toVersion(row: typeof modelConfigurationVersions.$inferSelect): ModelConfigurationVersion {
  return {
    id: row.id,
    version: row.version,
    source: row.source,
    config: row.config,
    evaluationNote: row.evaluationNote,
    createdAt: row.createdAt.toISOString(),
  };
}
