import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { RecallMemory, RecallQuery, RetrievalConfiguration } from '@memory-weave/contracts';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  conversations,
  memoryEntries,
  memorySearchTerms,
  memoryVersions,
} from '../../database/schema';
import { assertVersionSources, memoryRecordEvidence } from '../memories/memory-records';
import { ApiException } from '../../http/api-exception';
import { lexicalTerms } from './retrieval-lexical';

/** 按渠道融合排名，只在主库确认版本和全部来源后返回正文。 */
export async function recallCandidates(
  ownerId: string,
  companionId: string,
  query: RecallQuery,
  scope: SQL,
  limits: RetrievalConfiguration,
  tx: DatabaseTransaction,
  vectorIds: string[] = [],
): Promise<{ memories: RecallMemory[]; limited: boolean }> {
  const count = limits.candidates * (query.mode === 'history' ? 2 : 1);
  const filter = and(
    eq(memoryEntries.ownerId, ownerId),
    eq(memoryEntries.companionId, companionId),
    eq(memoryEntries.runtimeEpoch, query.runtimeEpoch),
    ne(memoryEntries.status, 'invalidated'),
    isNull(memoryVersions.invalidatedAt),
    isNull(conversations.lifecycleOperationId),
    scope,
    query.mode === 'ordinary' ? eq(memoryVersions.id, memoryEntries.currentVersionId) : undefined,
    query.memoryId ? eq(memoryEntries.id, query.memoryId) : undefined,
    query.subject
      ? sql`JSON_UNQUOTE(JSON_EXTRACT(${memoryVersions.document}, '$.subject.kind')) = ${query.subject}`
      : undefined,
    query.subjectName
      ? sql`JSON_UNQUOTE(JSON_EXTRACT(${memoryVersions.document}, '$.subject.name')) = ${query.subjectName}`
      : undefined,
    query.reality === 'fictional'
      ? sql`JSON_UNQUOTE(JSON_EXTRACT(${memoryVersions.document}, '$.reality')) = 'fictional'`
      : sql`JSON_UNQUOTE(JSON_EXTRACT(${memoryVersions.document}, '$.reality')) <> 'fictional'`,
    query.storyKey
      ? sql`JSON_UNQUOTE(JSON_EXTRACT(${memoryVersions.document}, '$.storyKey')) = ${query.storyKey}`
      : undefined,
  );
  const base = () =>
    tx
      .select({ entry: memoryEntries, version: memoryVersions })
      .from(memoryEntries)
      .innerJoin(memoryVersions, eq(memoryVersions.memoryId, memoryEntries.id))
      .innerJoin(conversations, eq(conversations.id, memoryEntries.conversationId));
  const terms = lexicalTerms(`${query.query}\n${query.context}`).slice(0, 64);
  const termHits = terms.length
    ? await tx
        .select({ id: memorySearchTerms.versionId, score: sql<number>`count(*)`.as('hits') })
        .from(memorySearchTerms)
        .innerJoin(memoryVersions, eq(memoryVersions.id, memorySearchTerms.versionId))
        .innerJoin(memoryEntries, eq(memoryEntries.id, memoryVersions.memoryId))
        .innerJoin(conversations, eq(conversations.id, memoryEntries.conversationId))
        .where(and(filter, inArray(memorySearchTerms.term, terms)))
        .groupBy(memorySearchTerms.versionId)
        .orderBy(desc(sql`hits`), desc(memorySearchTerms.versionId))
        .limit(count)
    : [];
  const latest = await base()
    .where(filter)
    .orderBy(desc(memoryVersions.createdAt), desc(memoryVersions.id))
    .limit(count);
  // 直接补查只弥补索引落后；时间近本身不构成相关性。
  const relatedLatest = latest.filter(
    (row) =>
      query.memoryId ||
      (row.version.document &&
        lexicalTerms(
          [
            row.version.document.text,
            row.version.document.subject.name,
            row.version.document.eventTime,
            row.version.document.storyKey,
          ]
            .filter(Boolean)
            .join(' '),
        ).some((term) => terms.includes(term))),
  );
  const channels: { name: RecallMemory['channels'][number]; ids: string[] }[] = [
    { name: query.memoryId ? 'direct' : 'recent', ids: relatedLatest.map((row) => row.version.id) },
    { name: 'lexical', ids: termHits.map((row) => row.id) },
    { name: 'vector', ids: vectorIds.slice(0, count) },
  ];
  const ranks = new Map<string, { score: number; channels: RecallMemory['channels'] }>();
  for (const channel of channels)
    channel.ids.forEach((id, index) => {
      const current = ranks.get(id) ?? { score: 0, channels: [] };
      current.score += 1 / (limits.rrfK + index + 1);
      current.channels.push(channel.name);
      ranks.set(id, current);
    });
  const ids = [...ranks]
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
    .map(([id]) => id);
  const rows = ids.length ? await base().where(and(filter, inArray(memoryVersions.id, ids))) : [];
  const byId = new Map(rows.map((row) => [row.version.id, row]));
  const memories: RecallMemory[] = [];
  let characters = 0;
  let budgetLimited = false;
  for (const id of ids) {
    const row = byId.get(id);
    if (!row?.version.document) continue;
    try {
      await assertVersionSources(ownerId, row.entry, row.version, tx);
    } catch (error) {
      if (error instanceof ApiException) continue;
      throw error;
    }
    const serialized = JSON.stringify(row.version.document);
    if (
      memories.length >= limits.results ||
      characters + serialized.length > limits.memoryCharacters
    ) {
      budgetLimited = true;
      break;
    }
    const evidence = await memoryRecordEvidence(
      ownerId,
      companionId,
      row.entry.id,
      id,
      { runtimeEpoch: query.runtimeEpoch, conversationId: row.entry.conversationId, limit: 3 },
      tx,
    );
    characters += serialized.length;
    memories.push({
      id: row.entry.id,
      versionId: id,
      version: row.version.version,
      conversationId: row.entry.conversationId,
      current: id === row.entry.currentVersionId,
      operation: row.version.operation,
      status: row.entry.status === 'disputed' ? 'disputed' : 'active',
      document: row.version.document,
      learnedAt: row.version.createdAt.toISOString(),
      channels: ranks.get(id)!.channels,
      evidence: evidence.items.map((item) => ({
        messageId: item.messageId,
        contentVersion: item.contentVersion,
        quote: item.quote,
      })),
    });
  }
  return {
    memories,
    limited:
      budgetLimited ||
      termHits.length === count ||
      latest.length === count ||
      vectorIds.length >= count,
  };
}
