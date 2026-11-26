import { Inject, Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import type {
  GrowthCandidate,
  GrowthCandidates,
  GrowthControl,
  GrowthFreeze,
  GrowthQuery,
  GrowthRollback,
  GrowthVersionQuery,
  PersonaVersion,
} from '@memory-weave/contracts';
import { and, asc, desc, eq, gt, lt } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import type { QueryDatabase } from '../../database/database.service';
import {
  conversations,
  growthCandidates,
  growthControls,
  personaVersions,
  reflectionRuns,
  tasks,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { toPersonaVersion } from '../companions/persona-version';
import { requireCompanion } from '../conversations/conversation-access';
import { fingerprint } from '../shared/http';
import { TaskStore } from '../tasks/task-store';
import { activeGrowth, appendGrowthPersona } from './growth-persona';

/** 读取当前冻结控制，首次没有记录时使用版本零。 */
export async function currentGrowthControl(
  ownerId: string,
  companionId: string,
  runtimeEpoch: number,
  db: QueryDatabase,
): Promise<GrowthControl> {
  const [row] = await db
    .select({ version: growthControls.version, frozen: growthControls.frozen })
    .from(growthControls)
    .where(
      and(
        eq(growthControls.ownerId, ownerId),
        eq(growthControls.companionId, companionId),
        eq(growthControls.runtimeEpoch, runtimeEpoch),
      ),
    )
    .orderBy(desc(growthControls.version))
    .limit(1);
  return { runtimeEpoch, version: row?.version ?? 0, frozen: row?.frozen ?? false };
}

/** 手动控制只影响成长，不写入初始人格或覆盖当前锁定项。 */
@Injectable()
export class GrowthService {
  /** 初始化成长管理。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
  ) {}

  /** 查询主库中的冻结版本。 */
  control(ownerId: string, id: string, runtimeEpoch: number): Promise<GrowthControl> {
    return this.store.locked(ownerId, async (tx) => {
      await requireCompanion(this.database, ownerId, id, runtimeEpoch, tx);
      return currentGrowthControl(ownerId, id, runtimeEpoch, tx);
    });
  }

  /** 幂等追加冻结操作，同时使此前的成长尝试失去提交资格。 */
  freeze(ownerId: string, id: string, command: GrowthFreeze): Promise<GrowthControl> {
    const requestId = command.requestId.toLowerCase();
    const hash = fingerprint({ ...command, requestId });
    const { runtimeEpoch, expectedVersion, frozen } = command;
    return this.store.locked(ownerId, async (tx, now) => {
      await requireCompanion(this.database, ownerId, id, runtimeEpoch, tx);
      const [replay] = await tx
        .select()
        .from(growthControls)
        .where(
          and(
            eq(growthControls.ownerId, ownerId),
            eq(growthControls.companionId, id),
            eq(growthControls.requestId, requestId),
          ),
        )
        .limit(1);
      if (replay) {
        if (replay.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return { runtimeEpoch, version: replay.version, frozen: replay.frozen };
      }
      const current = await currentGrowthControl(ownerId, id, runtimeEpoch, tx);
      if (current.version !== expectedVersion) throw new ApiException(API_CODES.VERSION_CONFLICT);
      if (current.version >= 2_147_483_647) throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
      const version = current.version + 1;
      await tx.insert(growthControls).values({
        ownerId,
        companionId: id,
        runtimeEpoch,
        requestId,
        fingerprint: hash,
        version,
        frozen,
        createdAt: now,
      });
      return { runtimeEpoch, version, frozen };
    });
  }

  /** 同代次回退追加新版本，当前名称、核心和约束保持来源于现行版本。 */
  rollback(ownerId: string, id: string, command: GrowthRollback): Promise<PersonaVersion> {
    const { runtimeEpoch } = command;
    const requestId = command.requestId.toLowerCase();
    const expected = command.expectedPersonaVersionId.toLowerCase();
    const targetId = command.targetPersonaVersionId.toLowerCase();
    const hash = fingerprint({
      runtimeEpoch,
      requestId,
      expected,
      targetId,
      kind: 'growth_rollback',
    });
    return this.store.locked(ownerId, async (tx, now) => {
      const companion = await requireCompanion(this.database, ownerId, id, runtimeEpoch, tx);
      const replay = await this.database.personaVersions.findOne(
        ownerId,
        { where: { companionId: id, commandId: requestId } },
        tx,
      );
      if (replay) {
        if (replay.runtimeEpoch !== runtimeEpoch || replay.commandFingerprint !== hash)
          throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return toPersonaVersion((await activeGrowth(replay, tx)).persona);
      }
      if (companion.currentPersonaVersionId !== expected)
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      const parent = await this.database.personaVersions.findOne(
        ownerId,
        {
          where: { companionId: id, runtimeEpoch, id: expected },
        },
        tx,
      );
      const target = await this.database.personaVersions.findOne(
        ownerId,
        {
          where: { companionId: id, runtimeEpoch, id: targetId },
        },
        tx,
      );
      if (!target) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      if (!parent?.document || !target.document) throw new ApiException(API_CODES.VERSION_CONFLICT);
      const safeTarget = (await activeGrowth(target, tx)).persona;
      const traits = target.document.growth ?? [];
      if (
        traits.length !== (safeTarget.document?.growth?.length ?? 0) ||
        (traits.length && fingerprint(target.document.locks) !== fingerprint(parent.document.locks))
      )
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      const row = await appendGrowthPersona(
        this.database,
        companion,
        parent,
        { ...parent.document, growth: traits },
        {
          origin: 'growth_rollback',
          mode: parent.mode,
          modelCallId: null,
          commandId: requestId,
          commandFingerprint: hash,
        },
        tx,
        now,
      );
      return toPersonaVersion(row);
    });
  }

  /** 通过实际任务、来源和采用版本查看候选。 */
  candidates(ownerId: string, id: string, query: GrowthQuery): Promise<GrowthCandidates> {
    return this.store.locked(ownerId, async (tx) => {
      await requireCompanion(this.database, ownerId, id, query.runtimeEpoch, tx);
      const rows = await tx
        .select({
          record: growthCandidates,
          runInvalidated: reflectionRuns.invalidatedAt,
          cleanup: conversations.lifecycleOperationId,
          taskStatus: tasks.status,
          taskReason: tasks.reason,
        })
        .from(growthCandidates)
        .innerJoin(
          reflectionRuns,
          and(
            eq(reflectionRuns.ownerId, ownerId),
            eq(reflectionRuns.id, growthCandidates.sourceRunId),
          ),
        )
        .innerJoin(tasks, and(eq(tasks.ownerId, ownerId), eq(tasks.id, growthCandidates.id)))
        .innerJoin(
          conversations,
          and(
            eq(conversations.ownerId, ownerId),
            eq(conversations.id, growthCandidates.conversationId),
          ),
        )
        .where(
          and(
            eq(growthCandidates.ownerId, ownerId),
            eq(growthCandidates.companionId, id),
            eq(growthCandidates.runtimeEpoch, query.runtimeEpoch),
            query.afterId ? gt(growthCandidates.id, query.afterId) : undefined,
          ),
        )
        .orderBy(asc(growthCandidates.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const items: GrowthCandidate[] = page.map(
        ({ record, runInvalidated, cleanup, taskStatus, taskReason }) => {
          const invalid = Boolean(runInvalidated || cleanup || record.erasedAt);
          const ended = ['failed', 'cancelled', 'blocked'].includes(taskStatus);
          return {
            id: record.id,
            taskId: record.id,
            mode: record.mode,
            sourceRunId: record.sourceRunId,
            expectedPersonaVersionId: record.expectedPersonaVersionId,
            adoptedPersonaVersionId: record.adoptedPersonaVersionId,
            status: invalid
              ? 'invalidated'
              : record.status === 'queued' && ended
                ? 'observing'
                : record.status,
            proposal: invalid ? null : record.proposal,
            validation: invalid ? null : record.validation,
            reason: invalid ? 'growth_source_changed' : (record.reason ?? taskReason),
            createdAt: record.createdAt.toISOString(),
          };
        },
      );
      return { items, nextAfterId: rows.length > query.limit ? page.at(-1)!.record.id : null };
    });
  }

  /** 历史版本只回查当前实例代次。 */
  versions(ownerId: string, id: string, query: GrowthVersionQuery) {
    return this.store.locked(ownerId, async (tx) => {
      await requireCompanion(this.database, ownerId, id, query.runtimeEpoch, tx);
      const rows = await tx
        .select()
        .from(personaVersions)
        .where(
          and(
            eq(personaVersions.ownerId, ownerId),
            eq(personaVersions.companionId, id),
            eq(personaVersions.runtimeEpoch, query.runtimeEpoch),
            query.beforeVersion ? lt(personaVersions.version, query.beforeVersion) : undefined,
          ),
        )
        .orderBy(desc(personaVersions.version))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const items = [];
      for (const row of page) items.push(toPersonaVersion((await activeGrowth(row, tx)).persona));
      return { items, nextBeforeVersion: rows.length > query.limit ? page.at(-1)!.version : null };
    });
  }
}
