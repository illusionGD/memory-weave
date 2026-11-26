import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { activities, activityVersions, lifecycleMessageTargets } from '../../database/schema';
import type { LifecycleCleanupPage } from '../lifecycle/lifecycle-cleanup';

/** 擦除由删除原文、终端来源或旧代次派生的委托和成果。 */
export const cleanupActivityPage: LifecycleCleanupPage = async (
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
  const rows = await tx
    .select({ taskId: activityVersions.taskId })
    .from(activityVersions)
    .innerJoin(
      activities,
      and(eq(activities.ownerId, ownerId), eq(activities.id, activityVersions.activityId)),
    )
    .where(
      and(
        eq(activityVersions.ownerId, ownerId),
        isNull(activityVersions.redactedAt),
        operation.kind === 'delete_messages'
          ? or(
              inArray(activityVersions.sourceMessageId, targets),
              inArray(activityVersions.actionSourceMessageId, targets),
            )
          : and(
              eq(activities.companionId, operation.companionId!),
              lte(activities.runtimeEpoch, operation.previousEpoch!),
            ),
      ),
    )
    .orderBy(asc(activityVersions.taskId))
    .limit(limit);
  if (rows.length)
    await tx
      .update(activityVersions)
      .set({
        specification: null,
        fingerprint: null,
        preparation: null,
        artifact: null,
        acknowledgedAt: null,
        redactedAt: new Date(),
      })
      .where(
        and(
          eq(activityVersions.ownerId, ownerId),
          inArray(
            activityVersions.taskId,
            rows.map((row) => row.taskId),
          ),
        ),
      );
  return { done: rows.length < limit, changed: rows.length };
};
