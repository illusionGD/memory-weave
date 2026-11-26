import { and, asc, eq, inArray, lte, ne } from 'drizzle-orm';
import { lifecycleMessageTargets, terminalActions, terminalGrants } from '../../database/schema';
import type { LifecycleCleanupPage } from '../lifecycle/lifecycle-cleanup';

/** 擦除由精确消息或旧实例代次派生的终端参数和结果，保留已派发的核对身份。 */
export const cleanupTerminalPage: LifecycleCleanupPage = async (
  _database,
  ownerId,
  tx,
  operation,
  limit,
) => {
  const content = operation.kind === 'delete_messages';
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
    .select({ id: terminalActions.id })
    .from(terminalActions)
    .where(
      and(
        eq(terminalActions.ownerId, ownerId),
        ne(terminalActions.state, 'invalidated'),
        content
          ? inArray(terminalActions.sourceMessageId, targets)
          : and(
              eq(terminalActions.companionId, operation.companionId!),
              lte(terminalActions.runtimeEpoch, operation.previousEpoch!),
            ),
      ),
    )
    .orderBy(asc(terminalActions.id))
    .limit(limit);
  if (rows.length) {
    await tx
      .update(terminalActions)
      .set({ state: 'invalidated', arguments: null, result: null, receiptHash: null })
      .where(
        and(
          eq(terminalActions.ownerId, ownerId),
          inArray(
            terminalActions.id,
            rows.map((row) => row.id),
          ),
        ),
      );
    return { done: false, changed: rows.length };
  }
  if (content) return { done: true, changed: 0 };
  const grants = await tx
    .select({ id: terminalGrants.id })
    .from(terminalGrants)
    .where(
      and(
        eq(terminalGrants.ownerId, ownerId),
        eq(terminalGrants.companionId, operation.companionId!),
        lte(terminalGrants.runtimeEpoch, operation.previousEpoch!),
        eq(terminalGrants.enabled, true),
      ),
    )
    .orderBy(asc(terminalGrants.id))
    .limit(limit);
  if (grants.length)
    await tx
      .update(terminalGrants)
      .set({ enabled: false })
      .where(
        and(
          eq(terminalGrants.ownerId, ownerId),
          inArray(
            terminalGrants.id,
            grants.map((row) => row.id),
          ),
        ),
      );
  return { done: grants.length === 0, changed: grants.length };
};
