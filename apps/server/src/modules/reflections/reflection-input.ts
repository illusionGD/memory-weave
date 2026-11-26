import { API_CODES } from '@memory-weave/contracts';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  activities,
  activityVersions,
  conversationMembers,
  memoryEntries,
  memoryEvidence,
  memoryOriginalSources,
  memoryVersions,
  messages,
  reflectionEvents,
  relationshipSources,
  relationshipStates,
  relationshipVersions,
  tasks,
  terminalActions,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { assertVisible } from '../conversations/conversation-access';
import type { ReflectionInput } from './reflection-types';

type Member = typeof conversationMembers.$inferSelect;
export type Event = typeof reflectionEvents.$inferSelect;
export interface OriginalRef {
  messageId: string;
  contentVersion: number;
}
export interface MaterializedEvent {
  input: ReflectionInput['events'][number];
  refs: OriginalRef[];
}

/** 核对确切发布版本和当前成员授权。 */
export async function reflectionOriginals(
  member: Member,
  refs: OriginalRef[],
  tx: DatabaseTransaction,
) {
  if (!refs.length) return new Map<string, typeof messages.$inferSelect>();
  const originals = await tx
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.ownerId, member.ownerId),
        eq(messages.conversationId, member.conversationId),
        eq(messages.state, 'published'),
        isNull(messages.deletedAt),
        inArray(
          messages.id,
          refs.map((ref) => ref.messageId),
        ),
      ),
    )
    .orderBy(asc(messages.sequence));
  const byId = new Map(originals.map((row) => [row.id, row]));
  for (const ref of refs) {
    const row = byId.get(ref.messageId);
    if (!row?.sequence || row.contentVersion !== ref.contentVersion)
      throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    await assertVisible(member, row.sequence, tx);
  }
  return byId;
}

/** 展开已发布原文、实际作品或已采用关系状态，不把意向当成经历。 */
export async function materializeReflectionEvent(
  event: Event,
  member: Member,
  tx: DatabaseTransaction,
): Promise<MaterializedEvent | null> {
  const { ownerId, companionId, runtimeEpoch, conversationId, sourceId, sourceVersion, kind } =
    event;
  if (
    event.status === 'invalidated' ||
    member.ownerId !== ownerId ||
    member.companionId !== companionId ||
    member.runtimeEpoch !== runtimeEpoch ||
    member.conversationId !== conversationId
  )
    return null;
  let refs: OriginalRef[];
  let text: string;
  let occurred: Date;
  let treatment: ReflectionInput['events'][number]['treatment'];
  if (kind === 'memory') {
    const [row] = await tx
      .select({ version: memoryVersions })
      .from(memoryVersions)
      .innerJoin(
        memoryEntries,
        and(eq(memoryEntries.ownerId, ownerId), eq(memoryEntries.id, memoryVersions.memoryId)),
      )
      .where(
        and(
          eq(memoryVersions.ownerId, ownerId),
          eq(memoryVersions.memoryId, sourceId),
          eq(memoryVersions.version, sourceVersion),
          isNull(memoryVersions.invalidatedAt),
          eq(memoryEntries.companionId, companionId),
          eq(memoryEntries.runtimeEpoch, runtimeEpoch),
          eq(memoryEntries.conversationId, conversationId),
          eq(memoryVersions.mode, event.mode),
        ),
      )
      .limit(1);
    if (!row?.version.document) return null;
    refs = await tx
      .select({
        messageId: memoryOriginalSources.messageId,
        contentVersion: memoryOriginalSources.contentVersion,
      })
      .from(memoryOriginalSources)
      .where(
        and(
          eq(memoryOriginalSources.ownerId, ownerId),
          eq(memoryOriginalSources.versionId, row.version.id),
        ),
      );
    const originals = await reflectionOriginals(member, refs, tx);
    const quotes = await tx
      .select({
        messageId: memoryEvidence.messageId,
        startOffset: memoryEvidence.startOffset,
        endOffset: memoryEvidence.endOffset,
      })
      .from(memoryEvidence)
      .where(
        and(
          eq(memoryEvidence.ownerId, ownerId),
          eq(memoryEvidence.versionId, row.version.id),
          eq(memoryEvidence.kind, 'quote'),
          isNull(memoryEvidence.material),
        ),
      )
      .orderBy(asc(memoryEvidence.messageId), asc(memoryEvidence.startOffset))
      .limit(4);
    text = quotes
      .map(
        (quote) =>
          originals.get(quote.messageId)?.text.slice(quote.startOffset, quote.endOffset) ?? '',
      )
      .filter(Boolean)
      .join('\n');
    occurred = [...originals.values()].at(-1)?.publishedAt ?? row.version.createdAt;
    treatment = quotes.some(
      (quote) => originals.get(quote.messageId)?.speakerMembershipId === member.id,
    )
      ? 'shared_exchange'
      : 'other_report';
  } else if (kind === 'activity') {
    const [row] = await tx
      .select({ version: activityVersions })
      .from(activityVersions)
      .innerJoin(
        activities,
        and(eq(activities.ownerId, ownerId), eq(activities.id, activityVersions.activityId)),
      )
      .innerJoin(
        tasks,
        and(
          eq(tasks.ownerId, ownerId),
          eq(tasks.id, activityVersions.taskId),
          eq(tasks.status, 'succeeded'),
        ),
      )
      .where(
        and(
          eq(activityVersions.ownerId, ownerId),
          eq(activityVersions.activityId, sourceId),
          eq(activityVersions.version, sourceVersion),
          isNull(activityVersions.redactedAt),
          eq(activities.companionId, companionId),
          eq(activities.runtimeEpoch, runtimeEpoch),
          eq(activities.conversationId, conversationId),
        ),
      )
      .limit(1);
    if (
      !row?.version.artifact ||
      row.version.artifact.mode !== event.mode ||
      !row.version.specification
    )
      return null;
    refs = row.version.specification.source ? [row.version.specification.source] : [];
    if (row.version.specification.dependsOnActionId && row.version.actionSourceMessageId) {
      const [action] = await tx
        .select({
          messageId: terminalActions.sourceMessageId,
          contentVersion: terminalActions.sourceContentVersion,
        })
        .from(terminalActions)
        .where(
          and(
            eq(terminalActions.ownerId, ownerId),
            eq(terminalActions.id, row.version.specification.dependsOnActionId),
            eq(terminalActions.state, 'succeeded'),
          ),
        )
        .limit(1);
      if (!action?.messageId || !action.contentVersion) return null;
      refs.push({ messageId: action.messageId, contentVersion: action.contentVersion });
    }
    await reflectionOriginals(member, refs, tx);
    text = row.version.artifact.text;
    occurred = new Date(row.version.artifact.createdAt);
    treatment = 'own_action';
  } else {
    const [row] = await tx
      .select({ version: relationshipVersions })
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
          eq(relationshipVersions.stateId, sourceId),
          eq(relationshipVersions.version, sourceVersion),
          isNull(relationshipVersions.invalidatedAt),
          eq(relationshipStates.companionId, companionId),
          eq(relationshipStates.runtimeEpoch, runtimeEpoch),
          eq(relationshipStates.conversationId, conversationId),
          eq(relationshipVersions.mode, event.mode),
        ),
      )
      .limit(1);
    if (!row?.version.document) return null;
    refs = await tx
      .select({
        messageId: relationshipSources.messageId,
        contentVersion: relationshipSources.contentVersion,
      })
      .from(relationshipSources)
      .where(
        and(
          eq(relationshipSources.ownerId, ownerId),
          eq(relationshipSources.versionId, row.version.id),
        ),
      );
    const originals = await reflectionOriginals(member, refs, tx);
    text = (row.version.evidence ?? [])
      .map((ref) => originals.get(ref.messageId)?.text.slice(ref.startOffset, ref.endOffset) ?? '')
      .filter(Boolean)
      .join('\n');
    occurred = row.version.observedAt;
    treatment = 'shared_exchange';
  }
  const excerpt = text
    .trim()
    .slice(0, 650)
    .replace(/[\uD800-\uDBFF]$/u, '');
  if (!excerpt || !Number.isFinite(occurred.getTime())) return null;
  return {
    input: {
      eventId: event.id,
      kind,
      sourceId,
      sourceVersion,
      text: excerpt,
      occurredAt: occurred.toISOString(),
      priority: event.priority,
      treatment,
    },
    refs,
  };
}
