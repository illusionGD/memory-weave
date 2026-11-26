import { and, asc, eq, inArray, isNotNull, lte, ne, or } from 'drizzle-orm';
import {
  autonomyOpportunities,
  contactIntents,
  lifecycleMessageTargets,
} from '../../database/schema';
import type { LifecycleCleanupPage } from '../lifecycle/lifecycle-cleanup';

/** 擦除失效意向的正文和模型依据，保留已占用额度及发布身份。 */
export const cleanupAutonomyPage: LifecycleCleanupPage = async (
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
  const content = operation.kind === 'delete_messages';
  const opportunities = await tx
    .select({ id: autonomyOpportunities.id })
    .from(autonomyOpportunities)
    .where(
      and(
        eq(autonomyOpportunities.ownerId, ownerId),
        ne(autonomyOpportunities.outcome, 'invalidated'),
        content
          ? inArray(autonomyOpportunities.sourceMessageId, targets)
          : and(
              eq(autonomyOpportunities.companionId, operation.companionId!),
              lte(autonomyOpportunities.runtimeEpoch, operation.previousEpoch!),
            ),
      ),
    )
    .orderBy(asc(autonomyOpportunities.id))
    .limit(limit);
  if (opportunities.length)
    await tx
      .update(autonomyOpportunities)
      .set({
        outcome: 'invalidated',
        explanation: null,
        preparation: null,
        reason: 'autonomy_scope_changed',
      })
      .where(
        and(
          eq(autonomyOpportunities.ownerId, ownerId),
          inArray(
            autonomyOpportunities.id,
            opportunities.map((row) => row.id),
          ),
        ),
      );
  const contacts = await tx
    .select({ id: contactIntents.id })
    .from(contactIntents)
    .where(
      and(
        eq(contactIntents.ownerId, ownerId),
        or(
          ne(contactIntents.state, 'cancelled'),
          isNotNull(contactIntents.explanation),
          isNotNull(contactIntents.text),
        ),
        content
          ? or(
              inArray(contactIntents.sourceMessageId, targets),
              inArray(contactIntents.messageId, targets),
            )
          : and(
              eq(contactIntents.companionId, operation.companionId!),
              lte(contactIntents.runtimeEpoch, operation.previousEpoch!),
            ),
      ),
    )
    .orderBy(asc(contactIntents.id))
    .limit(limit);
  if (contacts.length)
    await tx
      .update(contactIntents)
      .set({ state: 'cancelled', explanation: null, text: null, reason: 'contact_scope_changed' })
      .where(
        and(
          eq(contactIntents.ownerId, ownerId),
          inArray(
            contactIntents.id,
            contacts.map((row) => row.id),
          ),
        ),
      );
  return {
    done: opportunities.length < limit && contacts.length < limit,
    changed: opportunities.length + contacts.length,
  };
};
