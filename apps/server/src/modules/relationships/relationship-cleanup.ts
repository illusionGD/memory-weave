import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  lifecycleMessageTargets,
  relationshipSources,
  relationshipStates,
  relationshipVersions,
} from '../../database/schema';
import type { LifecycleCleanupPage } from '../lifecycle/lifecycle-cleanup';

/** 删除任一实际输入后擦除关系版本，避免当前关系自动回退到旧推断。 */
export const cleanupRelationshipPage: LifecycleCleanupPage = async (
  _database,
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
  const versionIds = tx
    .select({ id: relationshipSources.versionId })
    .from(relationshipSources)
    .where(
      and(
        eq(relationshipSources.ownerId, ownerId),
        inArray(relationshipSources.messageId, targets),
      ),
    );
  const rows = await tx
    .select({
      id: relationshipVersions.id,
      stateId: relationshipStates.id,
      version: relationshipVersions.version,
    })
    .from(relationshipVersions)
    .innerJoin(
      relationshipStates,
      and(
        eq(relationshipStates.ownerId, ownerId),
        eq(relationshipStates.id, relationshipVersions.stateId),
      ),
    )
    .where(
      and(
        eq(relationshipVersions.ownerId, ownerId),
        isNull(relationshipVersions.invalidatedAt),
        operation.kind === 'delete_messages'
          ? inArray(relationshipVersions.id, versionIds)
          : and(
              eq(relationshipStates.companionId, operation.companionId!),
              lte(relationshipStates.runtimeEpoch, operation.previousEpoch!),
            ),
      ),
    )
    .orderBy(asc(relationshipVersions.id))
    .limit(limit);
  if (rows.length)
    await tx
      .update(relationshipVersions)
      .set({ document: null, evidence: null, invalidatedAt: new Date() })
      .where(
        and(
          eq(relationshipVersions.ownerId, ownerId),
          inArray(
            relationshipVersions.id,
            rows.map((row) => row.id),
          ),
        ),
      );
  // 源于原文的主题名称也属于可擦除内容。
  for (const row of rows)
    await tx
      .update(relationshipStates)
      .set({ topic: sql`CONCAT('_', ${relationshipStates.id})` })
      .where(
        and(
          eq(relationshipStates.ownerId, ownerId),
          eq(relationshipStates.id, row.stateId),
          eq(relationshipStates.currentVersion, row.version),
        ),
      );
  return { done: rows.length < limit, changed: rows.length };
};
