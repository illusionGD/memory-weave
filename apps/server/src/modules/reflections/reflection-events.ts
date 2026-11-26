import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { ActivityScope, ReflectionSource } from '@memory-weave/contracts';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  reflectionEvents,
  reflectionFindings,
  reflectionRunEvents,
  reflectionRuns,
} from '../../database/schema';

interface EventSource {
  kind: ReflectionSource['kind'];
  sourceId: string;
  sourceVersion: number;
  mode: 'test' | 'model';
  priority: number;
}

/** 在来源事务提交时登记真实结果，同一版本只占一个候选位置。 */
export async function stageReflectionEvent(
  ownerId: string,
  scope: ActivityScope,
  source: EventSource,
  tx: DatabaseTransaction,
): Promise<void> {
  const { companionId, runtimeEpoch, conversationId } = scope;
  await tx
    .insert(reflectionEvents)
    .values({ ownerId, companionId, runtimeEpoch, conversationId, ...source })
    .onDuplicateKeyUpdate({ set: { id: sql`${reflectionEvents.id}` } });
}

/** 确认更正后立即停止使用该记忆以前版本派生的认识。 */
export async function invalidateCorrectedReflection(
  ownerId: string,
  memoryId: string,
  correctedVersion: number,
  tx: DatabaseTransaction,
): Promise<void> {
  const scope = and(
    eq(reflectionEvents.ownerId, ownerId),
    eq(reflectionEvents.kind, 'memory'),
    eq(reflectionEvents.sourceId, memoryId),
    lt(reflectionEvents.sourceVersion, correctedVersion),
  );
  const changed = tx.select({ id: reflectionEvents.id }).from(reflectionEvents).where(scope);
  const runs = tx
    .select({ id: reflectionRunEvents.runId })
    .from(reflectionRunEvents)
    .where(
      and(eq(reflectionRunEvents.ownerId, ownerId), inArray(reflectionRunEvents.eventId, changed)),
    );
  await tx.update(reflectionEvents).set({ status: 'invalidated' }).where(scope);
  await tx
    .update(reflectionRuns)
    .set({ invalidatedAt: new Date() })
    .where(and(eq(reflectionRuns.ownerId, ownerId), inArray(reflectionRuns.id, runs)));
  await tx
    .update(reflectionFindings)
    .set({ status: 'invalidated' })
    .where(and(eq(reflectionFindings.ownerId, ownerId), inArray(reflectionFindings.runId, runs)));
}
