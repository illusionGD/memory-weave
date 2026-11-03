import { and, eq, inArray, isNotNull, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  lifecycleMessageTargets,
  memoryBatches,
  memoryDependencies,
  memoryEntries,
  memoryEvidence,
  memoryVersions,
  messages,
  processingRanges,
} from '../../database/schema';
import { tables } from '../../database/tables';
import type { CleanupPage, LifecycleRecord } from '../lifecycle/lifecycle-cleanup';
import { lifecycleConversationScope } from '../lifecycle/lifecycle-scope';

/**
 * 清理当前生命周期操作涉及的记忆数据。
 *
 * F08 的清理步骤不访问外部服务，正文擦除与进度在同一事务中提交。
 */
export async function cleanupMemoryPage(
  ownerId: string,
  tx: DatabaseTransaction,
  operation: LifecycleRecord,
  stage: string,
  limit: number,
): Promise<CleanupPage> {
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
  const entryScope = content
    ? lifecycleConversationScope(memoryEntries.conversationId, operation)
    : and(
        eq(memoryEntries.companionId, operation.companionId!),
        lte(memoryEntries.runtimeEpoch, operation.previousEpoch!),
      );
  if (stage === 'memory_versions') {
    const affected = tx
      .select({ id: memoryEvidence.versionId })
      .from(memoryEvidence)
      .where(and(eq(memoryEvidence.ownerId, ownerId), inArray(memoryEvidence.messageId, targets)));
    const ancestor = alias(memoryVersions, 'memory_ancestor');
    const derived = tx
      .select({ id: memoryDependencies.versionId })
      .from(memoryDependencies)
      .innerJoin(ancestor, eq(ancestor.id, memoryDependencies.sourceVersionId))
      .where(and(eq(memoryDependencies.ownerId, ownerId), isNotNull(ancestor.invalidatedAt)));
    const rows = await tx
      .select({ id: memoryVersions.id })
      .from(memoryVersions)
      .innerJoin(memoryEntries, eq(memoryEntries.id, memoryVersions.memoryId))
      .where(
        and(
          eq(memoryVersions.ownerId, ownerId),
          entryScope,
          isNull(memoryVersions.invalidatedAt),
          content
            ? or(inArray(memoryVersions.id, affected), inArray(memoryVersions.id, derived))
            : undefined,
        ),
      )
      .limit(limit);
    if (rows.length) {
      const ids = rows.map((row) => row.id);
      await tables.memoryEntries.bind(tx, ownerId).updateWhere({
        where: inArray(memoryEntries.currentVersionId, ids),
        set: { status: 'invalidated' },
      });
      await tx
        .update(memoryVersions)
        .set({ document: null, reason: null, fingerprint: 'deleted', invalidatedAt: new Date() })
        .where(inArray(memoryVersions.id, ids));
    }
    return { done: rows.length === 0, changed: rows.length };
  }
  if (stage === 'memory_requeue') {
    if (!content) return { done: true, changed: 0 };
    // 失去上下文依赖的旧结论不能回退；仍然存在的独立原文重新进入整理队列。
    const dependencies = tx
      .select({ id: memoryEvidence.messageId })
      .from(memoryEvidence)
      .innerJoin(memoryVersions, eq(memoryVersions.id, memoryEvidence.versionId))
      .innerJoin(memoryEntries, eq(memoryEntries.id, memoryVersions.memoryId))
      .where(
        and(
          eq(memoryEvidence.ownerId, ownerId),
          entryScope,
          isNotNull(memoryVersions.invalidatedAt),
          sql`${memoryEntries.companionId} = ${processingRanges.companionId} AND ${memoryEntries.runtimeEpoch} = ${processingRanges.runtimeEpoch}`,
        ),
      );
    const rows = await tx
      .select({ id: processingRanges.id })
      .from(processingRanges)
      .innerJoin(messages, eq(messages.id, processingRanges.messageId))
      .where(
        and(
          eq(processingRanges.ownerId, ownerId),
          lifecycleConversationScope(processingRanges.conversationId, operation),
          ne(processingRanges.status, 'pending'),
          isNull(messages.deletedAt),
          notInArray(processingRanges.messageId, targets),
          sql`(${processingRanges.status} = 'processing' OR ${processingRanges.messageId} IN (${dependencies}))`,
        ),
      )
      .limit(limit);
    if (rows.length)
      await tables.processingRanges.bind(tx, ownerId).updateWhere({
        where: inArray(
          processingRanges.id,
          rows.map((row) => row.id),
        ),
        set: { status: 'pending', batchId: null },
      });
    return { done: rows.length === 0, changed: rows.length };
  }
  if (stage === 'memory_evidence') {
    const invalid = tx
      .select({ id: memoryVersions.id })
      .from(memoryVersions)
      .innerJoin(memoryEntries, eq(memoryEntries.id, memoryVersions.memoryId))
      .where(
        and(
          eq(memoryVersions.ownerId, ownerId),
          entryScope,
          isNotNull(memoryVersions.invalidatedAt),
        ),
      );
    const rows = await tables.memoryEvidence.bind(tx, ownerId).findMany({
      where: inArray(memoryEvidence.versionId, invalid),
      fields: { id: memoryEvidence.id },
      limit: limit,
    });
    if (rows.length)
      await tx.delete(memoryEvidence).where(
        inArray(
          memoryEvidence.id,
          rows.map((row) => row.id),
        ),
      );
    return { done: rows.length === 0, changed: rows.length };
  }
  const rows = await tables.memoryBatches.bind(tx, ownerId).findMany({
    where: and(
      isNotNull(memoryBatches.input),
      content
        ? lifecycleConversationScope(memoryBatches.conversationId, operation)
        : and(
            eq(memoryBatches.companionId, operation.companionId!),
            lte(memoryBatches.runtimeEpoch, operation.previousEpoch!),
          ),
    ),
    fields: { id: memoryBatches.id },
    limit: limit,
  });
  if (rows.length)
    await tables.memoryBatches.bind(tx, ownerId).updateWhere({
      where: inArray(
        memoryBatches.id,
        rows.map((row) => row.id),
      ),
      set: { input: null, outcomes: null, completedAt: new Date() },
    });
  return { done: rows.length === 0, changed: rows.length };
}
