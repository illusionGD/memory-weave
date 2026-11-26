import { and, asc, eq, isNotNull, lte, or } from 'drizzle-orm';
import { groupTurnSteps, groupTurns } from '../../database/schema';
import type { LifecycleCleanupPage } from '../lifecycle/lifecycle-cleanup';
import { lifecycleConversationScope } from '../lifecycle/lifecycle-scope';

/** 在删除或重置阶段擦除尚未完成的输入快照。 */
export const cleanupGroupTurnPage: LifecycleCleanupPage = async (
  _database,
  ownerId,
  tx,
  operation,
  limit,
) => {
  const rows = await tx
    .select({ turnId: groupTurnSteps.turnId, ordinal: groupTurnSteps.ordinal })
    .from(groupTurnSteps)
    .innerJoin(
      groupTurns,
      and(eq(groupTurns.ownerId, ownerId), eq(groupTurns.id, groupTurnSteps.turnId)),
    )
    .where(
      and(
        eq(groupTurnSteps.ownerId, ownerId),
        isNotNull(groupTurnSteps.preparation),
        operation.kind === 'delete_messages'
          ? lifecycleConversationScope(groupTurns.conversationId, operation)
          : and(
              eq(groupTurnSteps.companionId, operation.companionId!),
              lte(groupTurnSteps.runtimeEpoch, operation.previousEpoch!),
            ),
      ),
    )
    .orderBy(asc(groupTurnSteps.turnId), asc(groupTurnSteps.ordinal))
    .limit(limit);
  if (rows.length)
    await tx
      .update(groupTurnSteps)
      .set({ preparation: null })
      .where(
        and(
          eq(groupTurnSteps.ownerId, ownerId),
          or(
            ...rows.map((row) =>
              and(eq(groupTurnSteps.turnId, row.turnId), eq(groupTurnSteps.ordinal, row.ordinal)),
            ),
          ),
        ),
      );
  return { done: rows.length < limit, changed: rows.length };
};
