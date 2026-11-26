import { and, asc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import {
  groupTurnSteps,
  lifecycleMessageTargets,
  peerPolicies,
  peerSessions,
} from '../../database/schema';
import type { LifecycleCleanupPage } from '../lifecycle/lifecycle-cleanup';

/** 删除来源或重置时撤回旧话题和公开资料，计量仍用于防止重开额度。 */
export const cleanupPeerPage: LifecycleCleanupPage = async (
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
  const impactedTurns = tx
    .select({ id: groupTurnSteps.turnId })
    .from(groupTurnSteps)
    .where(
      and(
        eq(groupTurnSteps.ownerId, ownerId),
        eq(groupTurnSteps.companionId, operation.companionId ?? ''),
        lte(groupTurnSteps.runtimeEpoch, operation.previousEpoch ?? 0),
      ),
    );
  const content = operation.kind === 'delete_messages';
  const sessions = await tx
    .select({ id: peerSessions.id })
    .from(peerSessions)
    .where(
      and(
        eq(peerSessions.ownerId, ownerId),
        isNotNull(peerSessions.topicFingerprint),
        content
          ? inArray(peerSessions.triggerMessageId, targets)
          : inArray(peerSessions.id, impactedTurns),
      ),
    )
    .orderBy(asc(peerSessions.id))
    .limit(limit);
  if (sessions.length)
    await tx
      .update(peerSessions)
      .set({ topicFingerprint: null, reason: 'peer_source_changed' })
      .where(
        and(
          eq(peerSessions.ownerId, ownerId),
          inArray(
            peerSessions.id,
            sessions.map((row) => row.id),
          ),
        ),
      );
  if (content) return { done: sessions.length < limit, changed: sessions.length };
  const profiles = await tx
    .select({ id: peerPolicies.id })
    .from(peerPolicies)
    .where(
      and(
        eq(peerPolicies.ownerId, ownerId),
        eq(peerPolicies.companionId, operation.companionId!),
        lte(peerPolicies.runtimeEpoch, operation.previousEpoch!),
        isNotNull(peerPolicies.publicDescription),
      ),
    )
    .orderBy(asc(peerPolicies.id))
    .limit(limit);
  if (profiles.length)
    await tx
      .update(peerPolicies)
      .set({ publicDescription: null, enabled: false })
      .where(
        and(
          eq(peerPolicies.ownerId, ownerId),
          inArray(
            peerPolicies.id,
            profiles.map((row) => row.id),
          ),
        ),
      );
  return {
    done: sessions.length < limit && profiles.length < limit,
    changed: sessions.length + profiles.length,
  };
};
