import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type {
  DatabaseService,
  DatabaseTransaction,
  QueryDatabase,
} from '../../database/database.service';
import {
  companions,
  conversations,
  growthCandidates,
  personaVersions,
  reflectionRunMessages,
  reflectionRuns,
} from '../../database/schema';
import type { PersonaDocument } from '@memory-weave/contracts';
import { API_CODES } from '@memory-weave/contracts';
import { randomUUID } from 'node:crypto';
import { ApiException } from '../../http/api-exception';

export type PersonaRow = typeof personaVersions.$inferSelect;
type CompanionRow = typeof companions.$inferSelect;

/** 读取当下仍有合法来源的成长。旧版本中的已撤回内容不能再参与运行。 */
export async function activeGrowth(
  persona: PersonaRow,
  tx: QueryDatabase,
  mode?: 'test' | 'model',
): Promise<{ persona: PersonaRow; sources: { messageId: string; contentVersion: number }[] }> {
  const traits = persona.document?.growth;
  if (!traits?.length) return { persona, sources: [] };
  const candidates = await tx
    .select({ id: growthCandidates.id, runId: growthCandidates.sourceRunId })
    .from(growthCandidates)
    .innerJoin(
      reflectionRuns,
      and(
        eq(reflectionRuns.ownerId, persona.ownerId),
        eq(reflectionRuns.id, growthCandidates.sourceRunId),
        isNull(reflectionRuns.invalidatedAt),
      ),
    )
    .innerJoin(
      conversations,
      and(
        eq(conversations.ownerId, persona.ownerId),
        eq(conversations.id, growthCandidates.conversationId),
        isNull(conversations.lifecycleOperationId),
      ),
    )
    .where(
      and(
        eq(growthCandidates.ownerId, persona.ownerId),
        eq(growthCandidates.companionId, persona.companionId),
        eq(growthCandidates.runtimeEpoch, persona.runtimeEpoch),
        eq(growthCandidates.status, 'adopted'),
        isNull(growthCandidates.erasedAt),
        inArray(
          growthCandidates.id,
          traits.map((trait) => trait.growthId),
        ),
        mode ? eq(growthCandidates.mode, mode) : undefined,
      ),
    );
  const approved = new Set(candidates.map(({ id }) => id));
  const kept = traits.filter((trait) => approved.has(trait.growthId));
  const runIds = candidates.map(({ runId }) => runId);
  const refs = runIds.length
    ? await tx
        .selectDistinct({
          messageId: reflectionRunMessages.messageId,
          contentVersion: reflectionRunMessages.contentVersion,
        })
        .from(reflectionRunMessages)
        .where(
          and(
            eq(reflectionRunMessages.ownerId, persona.ownerId),
            inArray(reflectionRunMessages.runId, runIds),
          ),
        )
        .orderBy(asc(reflectionRunMessages.messageId), asc(reflectionRunMessages.contentVersion))
    : [];
  return {
    persona:
      kept.length === traits.length
        ? persona
        : { ...persona, document: { ...persona.document!, growth: kept } },
    sources: refs,
  };
}

/** 追加人格版本，只由持有调度锁且已校验预期版本的调用方使用。 */
export async function appendGrowthPersona(
  database: DatabaseService,
  companion: CompanionRow,
  parent: PersonaRow,
  document: PersonaDocument,
  metadata: Pick<
    PersonaRow,
    'origin' | 'mode' | 'modelCallId' | 'commandId' | 'commandFingerprint'
  >,
  tx: DatabaseTransaction,
  now: Date,
): Promise<PersonaRow> {
  if (parent.version >= 2_147_483_647 || companion.version >= 2_147_483_647)
    throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
  const row = {
    ...parent,
    ...metadata,
    document,
    id: randomUUID(),
    parentVersionId: parent.id,
    version: parent.version + 1,
    createdAt: now,
  };
  await tx.insert(personaVersions).values(row);
  await database.companions.update(
    companion.ownerId,
    companion.id,
    {
      currentPersonaVersionId: row.id,
      version: companion.version + 1,
    },
    tx,
  );
  return row;
}
