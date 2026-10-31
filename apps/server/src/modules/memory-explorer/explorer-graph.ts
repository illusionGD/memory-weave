import { and, asc, eq, gt, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';
import { API_CODES, utcDateTimeSchema } from '@memory-weave/contracts';
import type {
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryGraphPage,
  MemoryGraphQuery,
} from '@memory-weave/contracts';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  conversations,
  memoryEntries,
  memoryVersions,
  memoryEvidence,
  memoryDependencies,
  messages,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { fingerprint } from '../shared/http';
import { assertVersionSources } from '../memories/memory-records';
import { explorerScope } from './explorer-access';
import { toExplorerItem, explorerSelection } from './explorer-records';
import type { ExplorerRecord } from './explorer-records';
const cursorSchema = z
  .object({
    scope: z.string().length(64),
    after: z.string().regex(/^[a-z]:[0-9a-f-]{36}$/),
    asOf: utcDateTimeSchema,
  })
  .strict();
type Candidate = {
  edge: MemoryGraphEdge;
  record?: ExplorerRecord;
  recordKind?: 'memory' | 'version';
  message?: typeof messages.$inferSelect;
};

/** 以真实持久关系生成一个有界邻接页；每个端点均核对当前来源，不保留独立图数据库副本。 */
export async function readMemoryGraph(
  ownerId: string,
  companionId: string,
  query: MemoryGraphQuery,
  tx: DatabaseTransaction,
  now: Date,
): Promise<MemoryGraphPage> {
  const scope = await explorerScope(ownerId, companionId, query, tx);
  const cursorScope = fingerprint({ ownerId, companionId, ...query, cursor: undefined });
  let after = '';
  let asOf = now.toISOString();
  if (query.cursor) {
    try {
      const cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')),
      );
      if (cursor.scope !== cursorScope || new Date(cursor.asOf) > now) throw new Error('invalid');
      after = cursor.after;
      asOf = cursor.asOf;
    } catch {
      throw new ApiException(API_CODES.INVALID_REQUEST);
    }
  }
  /** 查询自身的来源表，不能用未校验的节点或边标识直接返回正文。 */
  async function records(where: SQL) {
    return tx
      .select(explorerSelection)
      .from(memoryEntries)
      .innerJoin(conversations, eq(conversations.id, memoryEntries.conversationId))
      .innerJoin(memoryVersions, eq(memoryVersions.memoryId, memoryEntries.id))
      .where(
        and(
          scope,
          eq(memoryVersions.ownerId, ownerId),
          where,
          lte(memoryVersions.createdAt, new Date(asOf)),
        ),
      )
      .orderBy(asc(memoryVersions.id))
      .limit(query.limit + 1);
  }
  const [center] = await records(
    query.centerKind === 'memory'
      ? and(
          eq(memoryEntries.id, query.centerId),
          eq(memoryVersions.id, memoryEntries.currentVersionId),
        )!
      : eq(memoryVersions.id, query.centerId),
  );
  if (!center) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
  const centerKey = `${query.centerKind}:${query.centerId}`;
  const nodes = new Map<string, MemoryGraphNode>();
  /** 同一节点重复出现只映射一次，实际权限与引用有效性在每页重新检查。 */
  async function addRecord(row: ExplorerRecord, kind: 'memory' | 'version') {
    const id = `${kind}:${kind === 'memory' ? row.entry.id : row.version.id}`;
    if (nodes.has(id)) return;
    await assertVersionSources(ownerId, row.entry, row.version, tx);
    nodes.set(id, {
      id,
      kind,
      label: kind === 'memory' ? '记忆' : `版本 ${row.version.version}`,
      record: toExplorerItem(row),
      messageId: null,
      contentVersion: null,
      conversationId: row.entry.conversationId,
    });
  }
  await addRecord(center, query.centerKind);
  const candidates: Candidate[] = [];
  /** 前缀固定关系种类，数据库只读取该种类尚未返回的稳定身份。 */
  function afterKey(
    prefix: string,
    column: import('drizzle-orm/mysql-core').AnyMySqlColumn,
  ): SQL | undefined {
    if (!after) return undefined;
    if (prefix < after.slice(0, 2)) return sql`FALSE`;
    return prefix === after.slice(0, 2) ? gt(column, after.slice(2)) : undefined;
  }
  if (query.centerKind === 'memory') {
    const versions = await records(
      and(eq(memoryEntries.id, center.entry.id), afterKey('v:', memoryVersions.id))!,
    );
    for (const row of versions)
      candidates.push({
        edge: {
          id: `v:${row.version.id}`,
          source: centerKey,
          target: `version:${row.version.id}`,
          kind: 'version',
          quote: null,
        },
        record: row,
      });
  } else if (!center.version.invalidatedAt) {
    const ownKey = `v:${center.version.id}`;
    if (ownKey > after) {
      const [head] = await records(
        and(
          eq(memoryEntries.id, center.entry.id),
          eq(memoryVersions.id, center.entry.currentVersionId),
        )!,
      );
      if (head)
        candidates.push({
          edge: {
            id: ownKey,
            source: `memory:${center.entry.id}`,
            target: centerKey,
            kind: 'version',
            quote: null,
          },
          record: head,
          recordKind: 'memory',
        });
    }
    const previousKey = `r:${center.version.id}`;
    if (center.version.previousVersionId && previousKey > after) {
      const [previous] = await records(eq(memoryVersions.id, center.version.previousVersionId));
      if (previous) candidates.push({ edge: revisionEdge(center), record: previous });
    }
    const children = await records(
      and(
        eq(memoryVersions.previousVersionId, center.version.id),
        afterKey('r:', memoryVersions.id),
      )!,
    );
    for (const row of children) candidates.push({ edge: revisionEdge(row), record: row });
    // 入边和出边分别利用索引查询，最多各取一页，不递归加载祖先。
    for (const incoming of [false, true]) {
      const prefix = 'd:';
      const dependencies = await tx
        .select({ dependency: memoryDependencies, ...explorerSelection })
        .from(memoryDependencies)
        .innerJoin(
          memoryVersions,
          eq(
            memoryVersions.id,
            incoming ? memoryDependencies.versionId : memoryDependencies.sourceVersionId,
          ),
        )
        .innerJoin(memoryEntries, eq(memoryEntries.id, memoryVersions.memoryId))
        .innerJoin(conversations, eq(conversations.id, memoryEntries.conversationId))
        .where(
          and(
            scope,
            eq(memoryDependencies.ownerId, ownerId),
            eq(
              incoming ? memoryDependencies.sourceVersionId : memoryDependencies.versionId,
              center.version.id,
            ),
            incoming
              ? or(
                  isNull(memoryVersions.previousVersionId),
                  ne(memoryVersions.previousVersionId, center.version.id),
                )
              : center.version.previousVersionId
                ? ne(memoryDependencies.sourceVersionId, center.version.previousVersionId)
                : undefined,
            lte(memoryVersions.createdAt, new Date(asOf)),
            afterKey(prefix, memoryDependencies.id),
          ),
        )
        .orderBy(asc(memoryDependencies.id))
        .limit(query.limit + 1);
      for (const row of dependencies)
        candidates.push({
          edge: {
            id: `${prefix}${row.dependency.id}`,
            source: `version:${row.dependency.versionId}`,
            target: `version:${row.dependency.sourceVersionId}`,
            kind: 'dependency',
            quote: null,
          },
          record: row,
        });
    }
    const evidence = await tx
      .select({ evidence: memoryEvidence, message: messages })
      .from(memoryEvidence)
      .innerJoin(
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
          eq(memoryEvidence.versionId, center.version.id),
          afterKey('s:', memoryEvidence.id),
        ),
      )
      .orderBy(asc(memoryEvidence.id))
      .limit(query.limit + 1);
    for (const row of evidence)
      candidates.push({
        edge: {
          id: `s:${row.evidence.id}`,
          source: centerKey,
          target: `message:${row.message.id}`,
          kind: row.evidence.kind,
          quote:
            row.evidence.kind === 'quote'
              ? row.message.text.slice(row.evidence.startOffset, row.evidence.endOffset)
              : null,
        },
        message: row.message,
      });
  }
  candidates.sort((a, b) => a.edge.id.localeCompare(b.edge.id));
  const selected = candidates.slice(0, query.limit);
  for (const candidate of selected) {
    if (candidate.record) await addRecord(candidate.record, candidate.recordKind ?? 'version');
    if (candidate.message) {
      const message = candidate.message;
      nodes.set(`message:${message.id}`, {
        id: `message:${message.id}`,
        kind: 'message',
        label: `原文 #${message.sequence}`,
        record: null,
        messageId: message.id,
        contentVersion: message.contentVersion,
        conversationId: message.conversationId,
      });
    }
  }
  // 所有依赖端点都来自同范围查询；被删节点保留无正文身份，不借边复活原文。
  const edges = selected
    .map((item) => item.edge)
    .filter((edge) => nodes.has(edge.source) && nodes.has(edge.target));
  return {
    center: centerKey,
    nodes: [...nodes.values()],
    edges,
    asOf,
    nextCursor:
      candidates.length > query.limit
        ? Buffer.from(
            JSON.stringify({ scope: cursorScope, asOf, after: selected.at(-1)!.edge.id }),
          ).toString('base64url')
        : null,
  };
}
/** 只有显式 previousVersionId 可以解释为修订，通用上下文依赖另行标记。 */
function revisionEdge(row: ExplorerRecord): MemoryGraphEdge {
  const operation = row.version.operation;
  return {
    id: `r:${row.version.id}`,
    source: `version:${row.version.id}`,
    target: `version:${row.version.previousVersionId}`,
    kind: operation === 'add' ? 'dependency' : operation,
    quote: null,
  };
}
