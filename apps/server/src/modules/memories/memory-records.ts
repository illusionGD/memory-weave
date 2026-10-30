import { registerSearchDocument } from '../retrieval/retrieval-lexical';
import { and, asc, eq, gt, isNull, or, ne, isNotNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { API_CODES } from '@memory-weave/contracts';
import type {
  MemoryItem,
  MemoryList,
  MemoryQuery,
  MemoryDetail,
  MemoryEvidencePage,
} from '@memory-weave/contracts';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  memoryEntries,
  memoryVersions,
  memoryEvidence,
  memoryBatches,
  memoryDependencies,
  memoryOriginalSources,
  visibilityGrants,
  messages,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { requireCompanionMember } from '../conversations/conversation-access';
import { fingerprint } from '../shared/http';
import type { MemoryOutput } from './memory-definition';

type Entry = typeof memoryEntries.$inferSelect;
type Version = typeof memoryVersions.$inferSelect;
type Batch = typeof memoryBatches.$inferSelect;

/** 版本正文与当前可用状态分离，失效版本只返回无内容身份。 */
export function toMemoryItem(entry: Entry, version: Version): MemoryItem {
  return {
    id: entry.id,
    version: version.version,
    versionId: version.id,
    status: version.invalidatedAt ? 'invalidated' : entry.status,
    document: version.document,
    learnedAt: version.createdAt.toISOString(),
    mode: version.mode,
  };
}
/** 用有界存在性查询检查全部来源，不能靠截断证据绕过失效记录。 */
export async function assertVersionSources(
  ownerId: string,
  entry: Entry,
  version: Version,
  tx: DatabaseTransaction,
): Promise<void> {
  if (version.invalidatedAt) return;
  const member = await requireCompanionMember(
    ownerId,
    entry.companionId,
    entry.runtimeEpoch,
    entry.conversationId,
    tx,
  );
  const visible = tx
    .select({ id: visibilityGrants.id })
    .from(visibilityGrants)
    .where(
      and(
        eq(visibilityGrants.ownerId, ownerId),
        eq(visibilityGrants.membershipId, member.id),
        eq(visibilityGrants.permissionVersion, member.permissionVersion),
        sql`${visibilityGrants.startSequence} <= ${messages.sequence} AND (${visibilityGrants.endSequence} IS NULL OR ${visibilityGrants.endSequence} >= ${messages.sequence}) AND (${visibilityGrants.kind} = 'history' OR (${messages.sequence} >= ${member.joinedSequence} AND (${member.leftSequence} IS NULL OR ${messages.sequence} <= ${member.leftSequence})))`,
      ),
    );
  const [invalid] = await tx
    .select({ id: memoryEvidence.id })
    .from(memoryEvidence)
    .leftJoin(
      messages,
      and(
        eq(messages.ownerId, ownerId),
        eq(messages.id, memoryEvidence.messageId),
        eq(messages.contentVersion, memoryEvidence.contentVersion),
      ),
    )
    .where(
      and(
        eq(memoryEvidence.ownerId, ownerId),
        eq(memoryEvidence.versionId, version.id),
        or(
          isNull(messages.id),
          isNotNull(messages.deletedAt),
          ne(messages.state, 'published'),
          ne(messages.conversationId, entry.conversationId),
          sql`NOT EXISTS (${visible})`,
        ),
      ),
    )
    .limit(1);
  if (invalid) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
}
/** 证据独立分页，只从仍可见的原文取出精确片段。 */
async function evidenceFor(
  ownerId: string,
  entry: Entry,
  version: Version,
  tx: DatabaseTransaction,
  afterId?: string,
  limit = 20,
): Promise<MemoryEvidencePage> {
  if (version.invalidatedAt) return { items: [], nextAfterId: null };
  await assertVersionSources(ownerId, entry, version, tx);
  const rows = await tx
    .select({ evidence: memoryEvidence, source: messages })
    .from(memoryEvidence)
    .innerJoin(
      messages,
      and(
        eq(messages.id, memoryEvidence.messageId),
        eq(messages.contentVersion, memoryEvidence.contentVersion),
      ),
    )
    .where(
      and(
        eq(memoryEvidence.ownerId, ownerId),
        eq(memoryEvidence.versionId, version.id),
        eq(memoryEvidence.kind, 'quote'),
        afterId ? gt(memoryEvidence.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(memoryEvidence.id))
    .limit(limit + 1);
  return {
    items: rows.slice(0, limit).map(({ evidence, source }) => ({
      messageId: evidence.messageId,
      contentVersion: evidence.contentVersion,
      startOffset: evidence.startOffset,
      endOffset: evidence.endOffset,
      quote: source.text.slice(evidence.startOffset, evidence.endOffset),
    })),
    nextAfterId: rows.length > limit ? rows[limit - 1]!.evidence.id : null,
  };
}
/** 回查某个版本的后续证据页。 */
export async function memoryRecordEvidence(
  ownerId: string,
  companionId: string,
  id: string,
  versionId: string,
  query: MemoryQuery,
  tx: DatabaseTransaction,
): Promise<MemoryEvidencePage> {
  const [row] = await tx
    .select({ entry: memoryEntries, version: memoryVersions })
    .from(memoryEntries)
    .innerJoin(memoryVersions, eq(memoryVersions.memoryId, memoryEntries.id))
    .where(
      and(
        eq(memoryEntries.ownerId, ownerId),
        eq(memoryEntries.companionId, companionId),
        eq(memoryEntries.runtimeEpoch, query.runtimeEpoch),
        eq(memoryEntries.conversationId, query.conversationId),
        eq(memoryEntries.id, id),
        eq(memoryVersions.id, versionId),
      ),
    );
  if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
  return evidenceFor(ownerId, row.entry, row.version, tx, query.afterId, query.limit);
}
/** 当前版本的有界查询，不扫描会话全部原文。 */
export async function listMemoryRecords(
  ownerId: string,
  companionId: string,
  query: MemoryQuery,
  tx: DatabaseTransaction,
): Promise<MemoryList> {
  const rows = await tx
    .select({ entry: memoryEntries, version: memoryVersions })
    .from(memoryEntries)
    .innerJoin(memoryVersions, eq(memoryVersions.id, memoryEntries.currentVersionId))
    .where(
      and(
        eq(memoryEntries.ownerId, ownerId),
        eq(memoryEntries.companionId, companionId),
        eq(memoryEntries.runtimeEpoch, query.runtimeEpoch),
        eq(memoryEntries.conversationId, query.conversationId),
        query.afterId ? gt(memoryEntries.id, query.afterId) : undefined,
      ),
    )
    .orderBy(asc(memoryEntries.id))
    .limit(query.limit + 1);
  for (const row of rows.slice(0, query.limit))
    await assertVersionSources(ownerId, row.entry, row.version, tx);
  return {
    items: rows.slice(0, query.limit).map((row) => toMemoryItem(row.entry, row.version)),
    nextAfterId: rows.length > query.limit ? rows[query.limit - 1]!.entry.id : null,
  };
}
/** 历史版本与来源独立分页；删除正文后不展示旧证据。 */
export async function memoryRecordDetail(
  ownerId: string,
  companionId: string,
  id: string,
  query: MemoryQuery,
  tx: DatabaseTransaction,
): Promise<MemoryDetail> {
  const [entry] = await tx
    .select()
    .from(memoryEntries)
    .where(
      and(
        eq(memoryEntries.ownerId, ownerId),
        eq(memoryEntries.companionId, companionId),
        eq(memoryEntries.runtimeEpoch, query.runtimeEpoch),
        eq(memoryEntries.conversationId, query.conversationId),
        eq(memoryEntries.id, id),
      ),
    );
  if (!entry) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
  const [current] = await tx
    .select()
    .from(memoryVersions)
    .where(eq(memoryVersions.id, entry.currentVersionId));
  if (!current) throw new ApiException(API_CODES.DATA_UNAVAILABLE);
  await assertVersionSources(ownerId, entry, current, tx);
  const versions = await tx
    .select()
    .from(memoryVersions)
    .where(
      and(
        eq(memoryVersions.ownerId, ownerId),
        eq(memoryVersions.memoryId, id),
        query.afterId ? gt(memoryVersions.id, query.afterId) : undefined,
      ),
    )
    .orderBy(asc(memoryVersions.id))
    .limit(query.limit + 1);
  return {
    current: toMemoryItem(entry, current),
    versions: await Promise.all(
      versions.slice(0, query.limit).map(async (version) => {
        const evidence = await evidenceFor(ownerId, entry, version, tx);
        return {
          ...toMemoryItem(entry, version),
          operation: version.operation,
          previousVersionId: version.previousVersionId,
          reason: version.reason,
          evidence: evidence.items,
          evidenceNextAfterId: evidence.nextAfterId,
        };
      }),
    ),
    nextAfterId: versions.length > query.limit ? versions[query.limit - 1]!.id : null,
  };
}
/** 采用候选前检查精确来源、修订版本与现实作用域，整批失败则不推进任何范围。 */
export async function adoptMemories(
  ownerId: string,
  batch: Batch,
  output: MemoryOutput,
  tx: DatabaseTransaction,
) {
  const input = batch.input!;
  const counts = { add: 0, merge: 0, revise: 0, conflict: 0, defer: 0 };
  const used = new Set<string>();
  const changed = new Set<string>();
  const invalid = () => {
    throw new ApiException(API_CODES.MODEL_OUTPUT_INVALID);
  };
  for (const action of output.actions) {
    const quotes = action.evidence.map((e) => {
      const source = input.messages.find(
        (s) => s.messageId === e.messageId && s.contentVersion === e.contentVersion,
      );
      const startOffset = source?.text.indexOf(e.quote) ?? -1;
      if (!source || startOffset < 0) return invalid();
      return { source, startOffset, endOffset: startOffset + e.quote.length };
    });
    if (!quotes.some((q) => q.source.target)) invalid();
    for (const quote of quotes) if (quote.source.target) used.add(quote.source.messageId);
    if (action.action === 'defer') {
      if (action.document || action.targetId || action.targetVersion || action.revisionKind)
        invalid();
      counts.defer++;
      continue;
    }
    const doc = action.document;
    if (!doc) return invalid();
    if (
      (doc.reality === 'fictional') !== Boolean(doc.storyKey) ||
      (doc.reality === 'fictional' && doc.epistemic !== 'setting')
    )
      invalid();
    if (quotes.some((q) => q.source.reality === 'fictional') && doc.reality !== 'fictional')
      invalid();
    if ((doc.subject.kind === 'user' || doc.subject.kind === 'self') && doc.subject.name) invalid();
    if (doc.subject.kind === 'other' && !doc.subject.name) invalid();
    if (
      doc.subject.kind === 'user' &&
      doc.epistemic === 'statement' &&
      !quotes.some((q) => q.source.speaker.kind === 'user' && q.source.sourceKind === 'user_input')
    )
      invalid();
    if (action.action === 'revise' ? !action.revisionKind : action.revisionKind !== null) invalid();
    const hash = fingerprint(doc);
    let entry: Entry | undefined;
    let previous: Version | undefined;
    if (action.action !== 'add') {
      const related = input.related.find(
        (item) => item.id === action.targetId && item.version === action.targetVersion,
      );
      if (!related || changed.has(related.id)) return invalid();
      [entry] = await tx
        .select()
        .from(memoryEntries)
        .where(and(eq(memoryEntries.ownerId, ownerId), eq(memoryEntries.id, related.id)))
        .for('update');
      if (!entry || entry.currentVersionId !== related.versionId || entry.status === 'invalidated')
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      [previous] = await tx
        .select()
        .from(memoryVersions)
        .where(eq(memoryVersions.id, entry.currentVersionId));
      if (
        !previous?.document ||
        previous.document.reality !== doc.reality ||
        previous.document.storyKey !== doc.storyKey ||
        fingerprint(previous.document.subject) !== fingerprint(doc.subject)
      )
        return invalid();
      changed.add(entry.id);
    } else {
      if (action.targetId || action.targetVersion) invalid();
      const [duplicate] = await tx
        .select({ entry: memoryEntries, version: memoryVersions })
        .from(memoryEntries)
        .innerJoin(memoryVersions, eq(memoryVersions.id, memoryEntries.currentVersionId))
        .where(
          and(
            eq(memoryEntries.ownerId, ownerId),
            eq(memoryEntries.companionId, batch.companionId),
            eq(memoryEntries.runtimeEpoch, batch.runtimeEpoch),
            eq(memoryEntries.conversationId, batch.conversationId),
            eq(memoryEntries.status, 'active'),
            eq(memoryVersions.fingerprint, hash),
            isNull(memoryVersions.invalidatedAt),
          ),
        )
        .limit(1);
      if (duplicate) {
        entry = duplicate.entry;
        previous = duplicate.version;
      }
    }
    const duplicate = Boolean(
      previous?.fingerprint === hash && (action.action === 'add' || action.action === 'merge'),
    );
    const entryId = entry?.id ?? randomUUID();
    const versionId = duplicate ? previous!.id : randomUUID();
    const version = duplicate ? entry!.version : (entry?.version ?? 0) + 1;
    if (version > 2147483647) throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
    const status =
      action.action === 'conflict' || entry?.status === 'disputed'
        ? ('disputed' as const)
        : ('active' as const);
    if (!entry)
      await tx.insert(memoryEntries).values({
        id: entryId,
        ownerId,
        companionId: batch.companionId,
        runtimeEpoch: batch.runtimeEpoch,
        conversationId: batch.conversationId,
        currentVersionId: versionId,
        version,
        status,
      });
    if (!duplicate) {
      await tx.insert(memoryVersions).values({
        id: versionId,
        ownerId,
        memoryId: entryId,
        version,
        batchId: batch.id,
        document: doc,
        fingerprint: hash,
        operation: action.action === 'revise' ? action.revisionKind! : action.action,
        previousVersionId: previous?.id ?? null,
        reason: action.reason,
        mode: batch.mode,
      });
      await registerSearchDocument(
        ownerId,
        versionId,
        entryId,
        {
          companionId: batch.companionId,
          runtimeEpoch: batch.runtimeEpoch,
          conversationId: batch.conversationId,
        },
        doc,
        tx,
      );
      if (entry)
        await tx
          .update(memoryEntries)
          .set({ currentVersionId: versionId, version, status })
          .where(eq(memoryEntries.id, entry.id));
    }
    // 新正文保守依赖本批全部上下文及旧版本；重复内容只补新证据，避免产生依赖环。
    const dependencies = [
      ...(duplicate
        ? []
        : input.messages.map((source) => ({
            messageId: source.messageId,
            contentVersion: source.contentVersion,
            startOffset: 0,
            endOffset: 0,
            kind: 'context' as const,
          }))),
      ...quotes.map((q) => ({
        messageId: q.source.messageId,
        contentVersion: q.source.contentVersion,
        startOffset: q.startOffset,
        endOffset: q.endOffset,
        kind: 'quote' as const,
      })),
    ];
    const unique = [...new Map(dependencies.map((e) => [JSON.stringify(e), e])).values()];
    for (const evidence of unique)
      await tx
        .insert(memoryEvidence)
        .values({ ...evidence, ownerId, versionId })
        .onDuplicateKeyUpdate({ set: { versionId } });
    const sourceIds = [...new Map(unique.map((e) => [e.messageId, e])).values()];
    if (sourceIds.length)
      await tx
        .insert(memoryOriginalSources)
        .values(
          sourceIds.map((e) => ({
            ownerId,
            versionId,
            messageId: e.messageId,
            contentVersion: e.contentVersion,
          })),
        )
        .onDuplicateKeyUpdate({ set: { versionId } });
    if (!duplicate && input.related.length)
      await tx
        .insert(memoryDependencies)
        .values(
          input.related.map((item) => ({ ownerId, versionId, sourceVersionId: item.versionId })),
        );
    counts[duplicate ? 'merge' : action.action]++;
  }
  counts.defer += input.messages.filter((m) => m.target && !used.has(m.messageId)).length;
  return counts;
}
