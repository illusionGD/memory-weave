import { and, eq, inArray } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service';
import { groupTurnHeads, groupTurns, groupTurnSteps, tasks } from '../../database/schema';
import type { TasksService } from '../tasks/tasks.service';

/** 用户插话或结束会话使尚未提交的发言作废，已经发布的消息继续保留。 */
export async function interruptGroupTurn(
  ownerId: string,
  conversationId: string,
  now: Date,
  tx: DatabaseTransaction,
  jobs: TasksService,
  newerUserSequence?: number,
): Promise<void> {
  const [current] = await tx
    .select({ turn: groupTurns })
    .from(groupTurnHeads)
    .innerJoin(
      groupTurns,
      and(eq(groupTurns.ownerId, ownerId), eq(groupTurns.id, groupTurnHeads.turnId)),
    )
    .innerJoin(
      tasks,
      and(
        eq(tasks.ownerId, ownerId),
        eq(tasks.id, groupTurns.id),
        inArray(tasks.status, ['queued', 'waiting', 'running', 'paused', 'blocked']),
      ),
    )
    .where(
      and(eq(groupTurnHeads.ownerId, ownerId), eq(groupTurnHeads.conversationId, conversationId)),
    )
    .limit(1);
  if (
    !current ||
    current.turn.interruptedAt ||
    (newerUserSequence !== undefined && current.turn.triggerSequence >= newerUserSequence)
  )
    return;
  await jobs.controlInTransaction(ownerId, tx, now, current.turn.id, 'cancel');
  await tx
    .update(groupTurns)
    .set({ interruptedAt: now })
    .where(and(eq(groupTurns.ownerId, ownerId), eq(groupTurns.id, current.turn.id)));
  await tx
    .update(groupTurnSteps)
    .set({ preparation: null })
    .where(and(eq(groupTurnSteps.ownerId, ownerId), eq(groupTurnSteps.turnId, current.turn.id)));
}
