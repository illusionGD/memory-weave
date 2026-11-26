import { Inject, Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import type { ChangeMemoryPin, MemoryPin } from '@memory-weave/contracts';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import { memoryMaintenanceViews, memoryPinChanges } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { assertVersionSources } from '../memories/memory-records';
import { fingerprint } from '../shared/http';
import { TaskStore } from '../tasks/task-store';

/** 显式固定可见的记忆，正文仍沿所属模块的修订和删除协议推进。 */
@Injectable()
export class MemoryPinService {
  /** 初始化固定操作及共用调度锁。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
  ) {}

  /** 查询当前固定状态。 */
  get(ownerId: string, companionId: string, memoryId: string, epoch: number): Promise<MemoryPin> {
    return this.store.locked(ownerId, async (tx) => {
      await this.memory(ownerId, companionId, memoryId, epoch, tx);
      return this.current(ownerId, memoryId, tx);
    });
  }

  /** 幂等改变固定状态，并移除旧的压缩或归档视图。 */
  change(
    ownerId: string,
    companionId: string,
    memoryId: string,
    command: ChangeMemoryPin,
  ): Promise<MemoryPin> {
    const hash = fingerprint({ companionId, memoryId, ...command });
    return this.store.locked(ownerId, async (tx, now) => {
      const entry = await this.memory(ownerId, companionId, memoryId, command.runtimeEpoch, tx);
      const [replay] = await tx
        .select()
        .from(memoryPinChanges)
        .where(
          and(
            eq(memoryPinChanges.ownerId, ownerId),
            eq(memoryPinChanges.requestId, command.requestId),
          ),
        )
        .limit(1);
      if (replay) {
        if (replay.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return { memoryId, pinned: replay.pinned, version: replay.version };
      }
      const current = await this.current(ownerId, memoryId, tx);
      if (
        current.version !== command.expectedPinVersion ||
        entry.version !== command.expectedMemoryVersion
      )
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      if (current.version >= 2147483647) throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
      const version = current.version + 1;
      await tx
        .update(memoryPinChanges)
        .set({ current: false })
        .where(
          and(
            eq(memoryPinChanges.ownerId, ownerId),
            eq(memoryPinChanges.memoryId, memoryId),
            eq(memoryPinChanges.current, true),
          ),
        );
      await tx
        .insert(memoryPinChanges)
        .values({
          ownerId,
          memoryId,
          version,
          requestId: command.requestId,
          fingerprint: hash,
          pinned: command.pinned,
          current: true,
          createdAt: now,
        });
      if (command.pinned)
        await tx
          .delete(memoryMaintenanceViews)
          .where(
            and(
              eq(memoryMaintenanceViews.ownerId, ownerId),
              eq(memoryMaintenanceViews.versionId, entry.currentVersionId),
            ),
          );
      return { memoryId, version, pinned: command.pinned };
    });
  }

  /** 验证实例、当前正文和证据归属。 */
  private async memory(
    ownerId: string,
    companionId: string,
    memoryId: string,
    epoch: number,
    tx: DatabaseTransaction,
  ) {
    const entry = await this.database.memoryEntries.findOne(
      ownerId,
      { where: { id: memoryId, companionId, runtimeEpoch: epoch } },
      tx,
    );
    const version =
      entry && (await this.database.memoryVersions.findById(ownerId, entry.currentVersionId, tx));
    if (!entry || entry.status === 'invalidated' || !version?.document || version.invalidatedAt)
      throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    await assertVersionSources(this.database, ownerId, entry, version, tx);
    return entry;
  }

  /** 返回尚无命令时的默认有效值。 */
  private async current(
    ownerId: string,
    memoryId: string,
    tx: DatabaseTransaction,
  ): Promise<MemoryPin> {
    const [row] = await tx
      .select()
      .from(memoryPinChanges)
      .where(
        and(
          eq(memoryPinChanges.ownerId, ownerId),
          eq(memoryPinChanges.memoryId, memoryId),
          eq(memoryPinChanges.current, true),
        ),
      )
      .limit(1);
    return { memoryId, version: row?.version ?? 0, pinned: row?.pinned ?? false };
  }
}
