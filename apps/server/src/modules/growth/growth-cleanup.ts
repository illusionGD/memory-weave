import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import {
  growthCandidates,
  lifecycleMessageTargets,
  personaVersions,
  reflectionRunMessages,
  reflectionRuns,
} from '../../database/schema';
import type { LifecycleCleanupPage } from '../lifecycle/lifecycle-cleanup';

/** 擦除由删除证据产生的成长正文和验证结果，回退不能复原。 */
export const cleanupGrowthPage: LifecycleCleanupPage = async (
  database,
  ownerId,
  tx,
  operation,
  limit,
) => {
  const targets = tx
    .select({ id: lifecycleMessageTargets.messageId })
    .from(lifecycleMessageTargets)
    .where(
      and(
        eq(lifecycleMessageTargets.ownerId, ownerId),
        eq(lifecycleMessageTargets.operationId, operation.id),
      ),
    );
  const runs = tx
    .select({ id: reflectionRunMessages.runId })
    .from(reflectionRunMessages)
    .where(
      and(
        eq(reflectionRunMessages.ownerId, ownerId),
        inArray(reflectionRunMessages.messageId, targets),
      ),
    );
  const affected =
    operation.kind === 'delete_messages'
      ? inArray(growthCandidates.sourceRunId, runs)
      : and(
          eq(growthCandidates.companionId, operation.companionId!),
          lte(growthCandidates.runtimeEpoch, operation.previousEpoch!),
        );
  const rows = await tx
    .select({ id: growthCandidates.id })
    .from(growthCandidates)
    .innerJoin(
      reflectionRuns,
      and(eq(reflectionRuns.ownerId, ownerId), eq(reflectionRuns.id, growthCandidates.sourceRunId)),
    )
    .where(
      and(
        eq(growthCandidates.ownerId, ownerId),
        isNull(growthCandidates.erasedAt),
        affected,
        isNotNull(reflectionRuns.redactedAt),
      ),
    )
    .orderBy(asc(growthCandidates.id))
    .limit(Math.min(limit, 24));

  const ids = rows.map((row) => row.id);
  if (!ids.length) return { done: true, changed: 0 };
  const versions = await database.personaVersions.findMany(
    ownerId,
    {
      where: or(
        ...ids.map(
          (id) =>
            sql`JSON_SEARCH(${personaVersions.document}, 'one', ${id}, NULL, '$.growth[*].growthId') IS NOT NULL`,
        ),
      ),
      orderBy: [asc(personaVersions.id)],
      limit,
    },
    tx,
  );
  const removed = new Set(ids);
  for (const row of versions) {
    if (!row.document?.growth) continue;
    await tx
      .update(personaVersions)
      .set({
        document: {
          ...row.document,
          growth: row.document.growth.filter((trait) => !removed.has(trait.growthId)),
        },
      })
      .where(and(eq(personaVersions.ownerId, ownerId), eq(personaVersions.id, row.id)));
  }
  if (versions.length >= limit) return { done: false, changed: versions.length };
  await tx
    .update(growthCandidates)
    .set({
      proposal: null,
      validation: null,
      erasedAt: new Date(),
      status: 'invalidated',
      reason: 'growth_source_changed',
    })
    .where(and(eq(growthCandidates.ownerId, ownerId), inArray(growthCandidates.id, ids)));
  return { done: false, changed: rows.length + versions.length };
};
