import { Inject, Injectable } from '@nestjs/common';
import { API_CODES, memoryMaintenanceConfigurationSchema } from '@memory-weave/contracts';
import type { MemoryMaintenance } from '@memory-weave/contracts';
import { and, asc, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { SERVER_CONFIG } from '../../config';
import type { RuntimeConfig } from '../../config';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  activities,
  activityVersions,
  growthCandidates,
  memoryEntries,
  memoryMaintenanceHeads,
  memoryMaintenanceViews,
  memoryOriginalSources,
  memoryVersions,
  messages,
  reflectionEvents,
  reflectionRunEvents,
  tasks,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { assertVersionSources } from '../memories/memory-records';
import type { CleanupPage, LifecycleRecord } from '../lifecycle/lifecycle-cleanup';
import { lifecycleMemoryTargets } from '../../database/schema';
import { TaskStore } from '../tasks/task-store';
import { compressExperience } from './memory-compression';

const millisecondsPerDay = 86400000;

/** 定期评估旧经历的读取层级，始终保留权威正文与确切来源。 */
@Injectable()
export class MemoryMaintenanceService {
  readonly policy;
  private nextPoll = 0;

  /** 加载部署维护策略。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(SERVER_CONFIG) config: RuntimeConfig,
  ) {
    this.policy =
      config.memoryMaintenanceConfiguration ?? memoryMaintenanceConfigurationSchema.parse({});
  }

  /** 有界后台检查，跨进程避免重复维护和仅因读取刷新时间。 */
  async wake(ownerId: string): Promise<void> {
    if (!this.policy.enabled || Date.now() < this.nextPoll) return;
    this.nextPoll = Date.now() + Math.min(this.policy.intervalMs, 60000);
    await this.store.locked(ownerId, async (tx, now) => {
      const [head] = await tx
        .select()
        .from(memoryMaintenanceHeads)
        .where(eq(memoryMaintenanceHeads.ownerId, ownerId))
        .limit(1);
      if (head && head.nextAt > now) return;
      await this.maintain(ownerId, tx, now);
      const nextAt = new Date(now.getTime() + this.policy.intervalMs);
      await tx
        .insert(memoryMaintenanceHeads)
        .values({ ownerId, nextAt })
        .onDuplicateKeyUpdate({ set: { nextAt } });
    });
  }

  /** 分层详情只在当前实例可以回查全部证据时返回。 */
  async view(
    ownerId: string,
    companionId: string,
    epoch: number,
    memoryId: string,
  ): Promise<MemoryMaintenance | null> {
    return this.store.locked(ownerId, async (tx) => {
      const [item] = await tx
        .select({ entry: memoryEntries, version: memoryVersions, view: memoryMaintenanceViews })
        .from(memoryEntries)
        .innerJoin(memoryVersions, eq(memoryVersions.id, memoryEntries.currentVersionId))
        .leftJoin(memoryMaintenanceViews, eq(memoryMaintenanceViews.versionId, memoryVersions.id))
        .where(
          and(
            eq(memoryEntries.ownerId, ownerId),
            eq(memoryEntries.companionId, companionId),
            eq(memoryEntries.runtimeEpoch, epoch),
            eq(memoryEntries.id, memoryId),
            isNull(memoryVersions.invalidatedAt),
          ),
        )
        .limit(1);
      if (!item || item.entry.status === 'invalidated')
        throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      await assertVersionSources(this.database, ownerId, item.entry, item.version, tx);
      if (!item.view) return null;
      const { view } = item;
      const evidence = await tx
        .select({
          messageId: memoryOriginalSources.messageId,
          contentVersion: memoryOriginalSources.contentVersion,
        })
        .from(memoryOriginalSources)
        .where(
          and(
            eq(memoryOriginalSources.ownerId, ownerId),
            eq(memoryOriginalSources.versionId, item.version.id),
          ),
        )
        .orderBy(asc(memoryOriginalSources.messageId));
      return {
        versionId: view.versionId,
        tier: view.tier,
        summary: view.summary,
        lastEvidenceAt: view.lastEvidenceAt.toISOString(),
        evaluatedAt: view.evaluatedAt.toISOString(),
        policy: view.policy,
        evidence,
      };
    });
  }

  /** 候选必须是历史发生的普通经历，保留进行中活动及成长证据。 */
  private async maintain(ownerId: string, tx: DatabaseTransaction, now: Date) {
    const recent = new Date(now.getTime() - this.policy.compressAfterDays * millisecondsPerDay);
    const archive = new Date(now.getTime() - this.policy.archiveAfterDays * millisecondsPerDay);
    const latest =
      sql<Date>`coalesce((select max(${messages.receivedAt}) from ${memoryOriginalSources} inner join ${messages} on ${messages.id} = ${memoryOriginalSources.messageId} where ${memoryOriginalSources.ownerId} = ${ownerId} and ${memoryOriginalSources.versionId} = ${memoryVersions.id}), ${memoryVersions.createdAt})`.mapWith(
        memoryVersions.createdAt,
      );
    const busy = tx
      .select({ id: activities.id })
      .from(activities)
      .innerJoin(
        activityVersions,
        and(
          eq(activityVersions.ownerId, ownerId),
          eq(activityVersions.activityId, activities.id),
          eq(activityVersions.version, activities.currentVersion),
        ),
      )
      .innerJoin(tasks, and(eq(tasks.ownerId, ownerId), eq(tasks.id, activityVersions.taskId)))
      .where(
        and(
          eq(activities.ownerId, ownerId),
          eq(activities.companionId, memoryEntries.companionId),
          eq(activities.runtimeEpoch, memoryEntries.runtimeEpoch),
          eq(activities.conversationId, memoryEntries.conversationId),
          inArray(tasks.status, ['queued', 'waiting', 'running', 'blocked', 'paused']),
        ),
      );
    const growth = tx
      .select({ id: growthCandidates.id })
      .from(reflectionEvents)
      .innerJoin(
        reflectionRunEvents,
        and(
          eq(reflectionRunEvents.ownerId, ownerId),
          eq(reflectionRunEvents.eventId, reflectionEvents.id),
        ),
      )
      .innerJoin(
        growthCandidates,
        and(
          eq(growthCandidates.ownerId, ownerId),
          eq(growthCandidates.sourceRunId, reflectionRunEvents.runId),
        ),
      )
      .where(
        and(
          eq(reflectionEvents.ownerId, ownerId),
          eq(reflectionEvents.kind, 'memory'),
          eq(reflectionEvents.sourceId, memoryEntries.id),
          eq(reflectionEvents.sourceVersion, memoryVersions.version),
          isNull(growthCandidates.erasedAt),
          inArray(growthCandidates.status, ['queued', 'observing', 'adopted']),
        ),
      );
    const rows = await tx
      .select({
        entry: memoryEntries,
        version: memoryVersions,
        last: latest,
        previous: memoryMaintenanceViews.tier,
      })
      .from(memoryEntries)
      .innerJoin(memoryVersions, eq(memoryVersions.id, memoryEntries.currentVersionId))
      .leftJoin(memoryMaintenanceViews, eq(memoryMaintenanceViews.versionId, memoryVersions.id))
      .where(
        and(
          eq(memoryEntries.ownerId, ownerId),
          eq(memoryEntries.status, 'active'),
          isNull(memoryVersions.invalidatedAt),
          sql`JSON_UNQUOTE(JSON_EXTRACT(${memoryVersions.document}, '$.kind')) = 'episodic'`,
          sql`JSON_UNQUOTE(JSON_EXTRACT(${memoryVersions.document}, '$.claim')) = 'experience'`,
          sql`JSON_UNQUOTE(JSON_EXTRACT(${memoryVersions.document}, '$.reality')) = 'real'`,
          sql`${latest} <= ${recent} and (${memoryMaintenanceViews.versionId} is null or (${memoryMaintenanceViews.tier} = 'compressed' and ${latest} <= ${archive}))`,
          notExists(busy),
          notExists(growth),
        ),
      )
      .orderBy(asc(memoryVersions.createdAt), asc(memoryVersions.id))
      .limit(this.policy.batchSize);
    for (const { entry, version, last } of rows) {
      if (!version.document) continue;
      try {
        await assertVersionSources(this.database, ownerId, entry, version, tx);
      } catch (error) {
        if (error instanceof ApiException) continue;
        throw error;
      }
      const tier = last <= archive ? ('archived' as const) : ('compressed' as const);
      const next = {
        tier,
        lastEvidenceAt: last,
        evaluatedAt: now,
        summary: compressExperience(version.document),
        policy: this.policy,
      };
      await tx
        .insert(memoryMaintenanceViews)
        .values({ ownerId, versionId: version.id, ...next })
        .onDuplicateKeyUpdate({ set: next });
    }
  }
}

/** 显式清理抹掉所有受影响的摘要副本。 */
export async function cleanupMaintenancePage(
  ownerId: string,
  tx: DatabaseTransaction,
  operation: LifecycleRecord,
  limit: number,
): Promise<CleanupPage> {
  const scope =
    operation.kind === 'delete_messages'
      ? inArray(
          memoryMaintenanceViews.versionId,
          tx
            .select({ id: lifecycleMemoryTargets.versionId })
            .from(lifecycleMemoryTargets)
            .where(
              and(
                eq(lifecycleMemoryTargets.ownerId, ownerId),
                eq(lifecycleMemoryTargets.operationId, operation.id),
              ),
            ),
        )
      : and(
          eq(memoryEntries.companionId, operation.companionId!),
          sql`${memoryEntries.runtimeEpoch} <= ${operation.previousEpoch}`,
        );
  const rows = await tx
    .select({ id: memoryMaintenanceViews.versionId })
    .from(memoryMaintenanceViews)
    .innerJoin(memoryVersions, eq(memoryVersions.id, memoryMaintenanceViews.versionId))
    .innerJoin(memoryEntries, eq(memoryEntries.id, memoryVersions.memoryId))
    .where(and(eq(memoryMaintenanceViews.ownerId, ownerId), scope))
    .limit(limit);
  const ids = rows.map(({ id }) => id);
  if (ids.length)
    await tx
      .delete(memoryMaintenanceViews)
      .where(
        and(
          eq(memoryMaintenanceViews.ownerId, ownerId),
          inArray(memoryMaintenanceViews.versionId, ids),
        ),
      );
  return { done: rows.length < limit, changed: rows.length };
}
