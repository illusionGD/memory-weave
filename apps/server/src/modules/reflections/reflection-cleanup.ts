import { and, asc, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import {
  lifecycleMessageTargets,
  reflectionEvents,
  reflectionFindings,
  reflectionRunMessages,
  reflectionRuns,
} from '../../database/schema';
import type { LifecycleCleanupPage } from '../lifecycle/lifecycle-cleanup';

/** 擦除来源已撤回的轮次、认识和自传，同时保留清理记录身份。 */
export const cleanupReflectionPage: LifecycleCleanupPage = async (
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
  const runIds = tx
    .select({ id: reflectionRunMessages.runId })
    .from(reflectionRunMessages)
    .where(
      and(
        eq(reflectionRunMessages.ownerId, ownerId),
        inArray(reflectionRunMessages.messageId, targets),
      ),
    );
  const content = operation.kind === 'delete_messages';
  const rows = await tx
    .select({ id: reflectionRuns.id })
    .from(reflectionRuns)
    .where(
      and(
        eq(reflectionRuns.ownerId, ownerId),
        isNull(reflectionRuns.redactedAt),
        content
          ? inArray(reflectionRuns.id, runIds)
          : and(
              eq(reflectionRuns.companionId, operation.companionId!),
              lte(reflectionRuns.runtimeEpoch, operation.previousEpoch!),
            ),
      ),
    )
    .orderBy(asc(reflectionRuns.id))
    .limit(limit);
  if (rows.length) {
    const now = new Date();
    const ids = rows.map((row) => row.id);
    await tx
      .update(reflectionRuns)
      .set({ input: null, result: null, invalidatedAt: now, redactedAt: now })
      .where(and(eq(reflectionRuns.ownerId, ownerId), inArray(reflectionRuns.id, ids)));
    await tx
      .update(reflectionFindings)
      .set({
        status: 'invalidated',
        document: null,
        evidence: null,
        erasedAt: now,
        topic: sql`CONCAT('_', ${reflectionFindings.rootId})`,
      })
      .where(and(eq(reflectionFindings.ownerId, ownerId), inArray(reflectionFindings.runId, ids)));
    return { done: false, changed: rows.length };
  }
  if (content) return { done: true, changed: 0 };
  const events = await tx
    .select({ id: reflectionEvents.id })
    .from(reflectionEvents)
    .where(
      and(
        eq(reflectionEvents.ownerId, ownerId),
        eq(reflectionEvents.companionId, operation.companionId!),
        lte(reflectionEvents.runtimeEpoch, operation.previousEpoch!),
        ne(reflectionEvents.status, 'invalidated'),
      ),
    )
    .orderBy(asc(reflectionEvents.id))
    .limit(limit);
  if (events.length)
    await tx
      .update(reflectionEvents)
      .set({ status: 'invalidated' })
      .where(
        and(
          eq(reflectionEvents.ownerId, ownerId),
          inArray(
            reflectionEvents.id,
            events.map((event) => event.id),
          ),
        ),
      );
  return { done: events.length < limit, changed: events.length };
};
