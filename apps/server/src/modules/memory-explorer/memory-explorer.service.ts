import { requireCompanion } from '../conversations/conversation-access';
import type {
  MemoryExplorerConversationsQuery,
  MemoryExplorerConversations,
} from '@memory-weave/contracts';
import type {
  MemoryExplorerValidation,
  MemoryExplorerValidationResult,
} from '@memory-weave/contracts';
import { readMemoryGraph } from './explorer-graph';
import {
  toExplorerItem,
  explorerSelection,
  explorerReadStamp,
  explorerStampSelection,
} from './explorer-records';
import type { MemoryGraphPage, MemoryGraphQuery } from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type {
  MemoryExplorerItem,
  MemoryExplorerPage,
  MemoryExplorerQuery,
} from '@memory-weave/contracts';
import {
  conversations,
  conversationMembers,
  memoryEntries,
  memoryVersions,
} from '../../database/schema';
import { TaskStore } from '../tasks/task-store';
import { assertVersionSources } from '../memories/memory-records';
import { explorerScope } from './explorer-access';
import { readExplorerCursor, writeExplorerCursor } from './explorer-cursor';

/** 后台只读浏览；有界事务与生命周期共用提交顺序，不产生模型调用。 */
@Injectable()
export class MemoryExplorerService {
  constructor(@Inject(TaskStore) private readonly store: TaskStore) {}
  /** 只提供该实例当前代次的会话选择，群聊仍需用户明确选择。 */
  conversations(
    companionId: string,
    query: MemoryExplorerConversationsQuery,
  ): Promise<MemoryExplorerConversations> {
    return this.store.locked(async (ownerId, tx) => {
      await requireCompanion(ownerId, companionId, query.runtimeEpoch, tx);
      const rows = await tx
        .select({ id: conversations.id, title: conversations.title, kind: conversations.kind })
        .from(conversations)
        .innerJoin(conversationMembers, eq(conversationMembers.conversationId, conversations.id))
        .where(
          and(
            eq(conversations.ownerId, ownerId),
            eq(conversationMembers.ownerId, ownerId),
            eq(conversationMembers.companionId, companionId),
            eq(conversationMembers.runtimeEpoch, query.runtimeEpoch),
            eq(conversationMembers.kind, 'companion'),
            isNull(conversationMembers.deletedAt),
            isNull(conversations.lifecycleOperationId),
            query.afterId ? gt(conversations.id, query.afterId) : undefined,
          ),
        )
        .orderBy(asc(conversations.id))
        .limit(query.limit + 1);
      return {
        items: rows.slice(0, query.limit),
        nextAfterId: rows.length > query.limit ? rows[query.limit - 1]!.id : null,
      };
    });
  }
  /** 批量核对当前画面的版本、来源内容版本及权限；不读取全部历史。 */
  validate(
    companionId: string,
    input: MemoryExplorerValidation,
  ): Promise<MemoryExplorerValidationResult> {
    return this.store.locked(async (ownerId, tx) => {
      const scope = await explorerScope(ownerId, companionId, input, tx);
      const expected = new Map(
        input.references.map((reference) => [reference.versionId, reference.stamp]),
      );
      if (!expected.size) return { valid: true };
      const rows = await tx
        .select(explorerStampSelection)
        .from(memoryEntries)
        .innerJoin(conversations, eq(conversations.id, memoryEntries.conversationId))
        .innerJoin(memoryVersions, eq(memoryVersions.memoryId, memoryEntries.id))
        .where(
          and(
            scope,
            eq(memoryVersions.ownerId, ownerId),
            inArray(memoryVersions.id, [...expected.keys()]),
          ),
        )
        .limit(input.references.length);
      return {
        valid:
          rows.length === expected.size &&
          rows.every((row) => expected.get(row.version.id) === explorerReadStamp(row)),
      };
    });
  }
  /** 按中心返回一批真实邻接关系，绝不递归加载全部历史。 */
  graph(companionId: string, query: MemoryGraphQuery): Promise<MemoryGraphPage> {
    return this.store.locked((ownerId, tx, now) =>
      readMemoryGraph(ownerId, companionId, query, tx, now),
    );
  }
  /** 仅返回当前版本，私聊汇总与单会话范围分别校验。 */
  entries(companionId: string, query: MemoryExplorerQuery): Promise<MemoryExplorerPage> {
    return this.records(companionId, query, 'entries');
  }
  /** 按记录时间浏览各语义版本，不把发生时间的文字描述强制转为日期。 */
  timeline(companionId: string, query: MemoryExplorerQuery): Promise<MemoryExplorerPage> {
    return this.records(companionId, query, 'timeline');
  }
  private records(
    companionId: string,
    query: MemoryExplorerQuery,
    view: 'entries' | 'timeline',
  ): Promise<MemoryExplorerPage> {
    return this.store.locked(async (ownerId, tx, now) => {
      const scope = await explorerScope(ownerId, companionId, query, tx);
      const cursorScope = { ownerId, companionId, view, ...query, cursor: undefined };
      const status = sql`CASE WHEN ${memoryVersions.invalidatedAt} IS NOT NULL THEN 'invalidated' WHEN ${memoryVersions.id} = ${memoryEntries.currentVersionId} THEN ${memoryEntries.status} WHEN ${memoryVersions.operation} = 'conflict' THEN 'disputed' ELSE 'active' END`;
      const cursor = readExplorerCursor(query.cursor, cursorScope, now);
      const asOf = cursor?.asOf ?? now.toISOString();
      const rows = await tx
        .select(explorerSelection)
        .from(memoryEntries)
        .innerJoin(conversations, eq(conversations.id, memoryEntries.conversationId))
        .innerJoin(
          memoryVersions,
          view === 'entries'
            ? eq(memoryVersions.id, memoryEntries.currentVersionId)
            : eq(memoryVersions.memoryId, memoryEntries.id),
        )
        .where(
          and(
            scope,
            eq(memoryVersions.ownerId, ownerId),
            lte(memoryVersions.createdAt, new Date(asOf)),
            query.q
              ? sql`LOCATE(${query.q}, JSON_UNQUOTE(JSON_EXTRACT(${memoryVersions.document}, '$.text'))) > 0`
              : undefined,
            query.kind
              ? sql`JSON_UNQUOTE(JSON_EXTRACT(${memoryVersions.document}, '$.kind')) = ${query.kind}`
              : undefined,
            query.claim
              ? sql`JSON_UNQUOTE(JSON_EXTRACT(${memoryVersions.document}, '$.claim')) = ${query.claim}`
              : undefined,
            query.reality
              ? sql`JSON_UNQUOTE(JSON_EXTRACT(${memoryVersions.document}, '$.reality')) = ${query.reality}`
              : undefined,
            query.storyKey
              ? sql`JSON_UNQUOTE(JSON_EXTRACT(${memoryVersions.document}, '$.storyKey')) = ${query.storyKey}`
              : undefined,
            query.status ? sql`${status} = ${query.status}` : undefined,
            query.from ? gte(memoryVersions.createdAt, new Date(query.from)) : undefined,
            query.until ? lte(memoryVersions.createdAt, new Date(query.until)) : undefined,
            cursor
              ? sql`(${memoryVersions.createdAt} < ${new Date(cursor.time)} OR (${memoryVersions.createdAt} = ${new Date(cursor.time)} AND ${memoryVersions.id} < ${cursor.id}))`
              : undefined,
          ),
        )
        .orderBy(desc(memoryVersions.createdAt), desc(memoryVersions.id))
        .limit(query.limit + 1);
      const items: MemoryExplorerItem[] = [];
      for (const row of rows.slice(0, query.limit)) {
        await assertVersionSources(ownerId, row.entry, row.version, tx);
        items.push(toExplorerItem(row));
      }
      const last = items.at(-1);
      return {
        items,
        asOf,
        nextCursor:
          rows.length > query.limit && last
            ? writeExplorerCursor(cursorScope, asOf, last.learnedAt, last.versionId)
            : null,
      };
    });
  }
}
