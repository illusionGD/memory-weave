import { and, eq, inArray, isNull, isNotNull, lte, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  chatMemorySources,
  chatSegments,
  lifecycleMemoryTargets,
  lifecycleMessageTargets,
  memoryDependencies,
  memoryEntries,
  memoryOriginalSources,
  memorySearchDocuments,
  memorySearchTerms,
  memoryVectorIndexes,
  memoryVersions,
  messages,
} from '../../database/schema';
import type { CleanupPage, LifecycleRecord } from '../lifecycle/lifecycle-cleanup';
import { lifecycleConversationScope } from '../lifecycle/lifecycle-scope';

/** 消息→记忆版本→旧版本依赖→回复，循环至固定点；不通过正文猜测关系。 */
export async function propagateRecallDeletion(
  ownerId: string,
  tx: DatabaseTransaction,
  operation: LifecycleRecord,
  limit: number,
): Promise<CleanupPage> {
  if (operation.kind !== 'delete_messages') return { done: true, changed: 0 };
  let changed = 0;
  const known = alias(lifecycleMemoryTargets, 'known_memory_target');
  const roots = await tx
    .selectDistinct({ versionId: memoryOriginalSources.versionId })
    .from(lifecycleMessageTargets)
    .innerJoin(
      memoryOriginalSources,
      and(
        eq(memoryOriginalSources.ownerId, ownerId),
        eq(memoryOriginalSources.messageId, lifecycleMessageTargets.messageId),
        eq(memoryOriginalSources.contentVersion, lifecycleMessageTargets.contentVersion),
      ),
    )
    .leftJoin(
      known,
      and(
        eq(known.operationId, operation.id),
        eq(known.versionId, memoryOriginalSources.versionId),
      ),
    )
    .where(
      and(
        eq(lifecycleMessageTargets.ownerId, ownerId),
        eq(lifecycleMessageTargets.operationId, operation.id),
        isNull(known.id),
      ),
    )
    .limit(limit);
  if (roots.length)
    await tx
      .insert(lifecycleMemoryTargets)
      .values(roots.map((row) => ({ ...row, ownerId, operationId: operation.id })));
  changed += roots.length;
  const derived = await tx
    .selectDistinct({ versionId: memoryDependencies.versionId })
    .from(lifecycleMemoryTargets)
    .innerJoin(
      memoryDependencies,
      and(
        eq(memoryDependencies.ownerId, ownerId),
        eq(memoryDependencies.sourceVersionId, lifecycleMemoryTargets.versionId),
      ),
    )
    .leftJoin(
      known,
      and(eq(known.operationId, operation.id), eq(known.versionId, memoryDependencies.versionId)),
    )
    .where(
      and(
        eq(lifecycleMemoryTargets.ownerId, ownerId),
        eq(lifecycleMemoryTargets.operationId, operation.id),
        isNull(known.id),
      ),
    )
    .limit(limit);
  if (derived.length)
    await tx
      .insert(lifecycleMemoryTargets)
      .values(derived.map((row) => ({ ...row, ownerId, operationId: operation.id })));
  changed += derived.length;
  const invalid = await tx
    .select({ id: memoryVersions.id })
    .from(lifecycleMemoryTargets)
    .innerJoin(memoryVersions, eq(memoryVersions.id, lifecycleMemoryTargets.versionId))
    .where(
      and(
        eq(lifecycleMemoryTargets.ownerId, ownerId),
        eq(lifecycleMemoryTargets.operationId, operation.id),
        isNull(memoryVersions.invalidatedAt),
      ),
    )
    .limit(limit);
  if (invalid.length) {
    const ids = invalid.map((row) => row.id);
    await tx
      .update(memoryEntries)
      .set({ status: 'invalidated' })
      .where(and(eq(memoryEntries.ownerId, ownerId), inArray(memoryEntries.currentVersionId, ids)));
    await tx
      .update(memoryVersions)
      .set({ document: null, reason: null, fingerprint: 'deleted', invalidatedAt: new Date() })
      .where(inArray(memoryVersions.id, ids));
  }
  changed += invalid.length;
  const knownMessage = alias(lifecycleMessageTargets, 'known_recall_message');
  const replies = await tx
    .selectDistinct({ messageId: messages.id, contentVersion: messages.contentVersion })
    .from(lifecycleMemoryTargets)
    .innerJoin(
      chatMemorySources,
      and(
        eq(chatMemorySources.ownerId, ownerId),
        eq(chatMemorySources.versionId, lifecycleMemoryTargets.versionId),
      ),
    )
    .innerJoin(chatSegments, eq(chatSegments.runId, chatMemorySources.runId))
    .innerJoin(messages, eq(messages.id, chatSegments.messageId))
    .leftJoin(
      knownMessage,
      and(eq(knownMessage.operationId, operation.id), eq(knownMessage.messageId, messages.id)),
    )
    .where(
      and(
        eq(lifecycleMemoryTargets.ownerId, ownerId),
        eq(lifecycleMemoryTargets.operationId, operation.id),
        isNull(knownMessage.id),
      ),
    )
    .limit(limit);
  if (replies.length)
    await tx.insert(lifecycleMessageTargets).values(
      replies.map((row) => ({
        ...row,
        ownerId,
        operationId: operation.id,
        kind: 'derived' as const,
      })),
    );
  changed += replies.length;
  return { done: changed === 0, changed };
}

/** 清除派生词项后删除索引待办文档，身份来源图保留而不保存正文。 */
export async function cleanupSearchPage(
  ownerId: string,
  tx: DatabaseTransaction,
  operation: LifecycleRecord,
  limit: number,
): Promise<CleanupPage> {
  const scope =
    operation.kind === 'delete_messages'
      ? lifecycleConversationScope(memoryEntries.conversationId, operation)
      : and(
          eq(memoryEntries.companionId, operation.companionId!),
          lte(memoryEntries.runtimeEpoch, operation.previousEpoch!),
        );
  const rows = await tx
    .select({ id: memorySearchDocuments.versionId })
    .from(memorySearchDocuments)
    .innerJoin(memoryEntries, eq(memoryEntries.id, memorySearchDocuments.memoryId))
    .innerJoin(memoryVersions, eq(memoryVersions.id, memorySearchDocuments.versionId))
    .where(
      and(
        eq(memorySearchDocuments.ownerId, ownerId),
        scope,
        isNotNull(memoryVersions.invalidatedAt),
      ),
    )
    .limit(limit);
  if (rows.length) {
    const ids = rows.map((row) => row.id);
    await tx.delete(memorySearchTerms).where(inArray(memorySearchTerms.versionId, ids));
    await tx.delete(memorySearchDocuments).where(inArray(memorySearchDocuments.versionId, ids));
  }
  return { done: rows.length === 0, changed: rows.length };
}

/** 只准备外部删除身份；请求在事务外执行，确认后再提交检查点。 */
export async function vectorCleanupRows(
  ownerId: string,
  tx: DatabaseTransaction,
  operation: LifecycleRecord,
  limit: number,
) {
  const scope =
    operation.kind === 'delete_messages'
      ? lifecycleConversationScope(memoryVectorIndexes.conversationId, operation)
      : and(
          eq(memoryVectorIndexes.companionId, operation.companionId!),
          lte(memoryVectorIndexes.runtimeEpoch, operation.previousEpoch!),
        );
  return tx
    .select({
      id: memoryVectorIndexes.id,
      versionId: memoryVectorIndexes.versionId,
      collection: memoryVectorIndexes.collection,
    })
    .from(memoryVectorIndexes)
    .innerJoin(memoryVersions, eq(memoryVersions.id, memoryVectorIndexes.versionId))
    .where(
      and(
        eq(memoryVectorIndexes.ownerId, ownerId),
        scope,
        isNotNull(memoryVersions.invalidatedAt),
        ne(memoryVectorIndexes.status, 'deleted'),
      ),
    )
    .limit(limit);
}
