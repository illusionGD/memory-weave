import type { SQL } from 'drizzle-orm';
import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  chatRuns,
  chatRunSources,
  chatSegments,
  chatThreads,
  conversationMembers,
  lifecycleMessageTargets,
  lifecycleOperations,
  messages,
  messageSources,
  modelCalls,
  personaFoundations,
  personaVersions,
  processingRanges,
  readReceipts,
  receiveBatches,
  taskOutbox,
  tasks,
} from '../../database/schema';
import { cleanupMemoryPage } from '../memories/memory-cleanup';
import { cleanupSearchPage, propagateRecallDeletion } from '../retrieval/retrieval-cleanup';
import { lifecycleConversationScope } from './lifecycle-scope';

/** 清理协议 v1 的有序阶段，新增派生模块必须增加自己的清理阶段与读取围栏。 */
const LIFECYCLE_STAGES_V1 = [
  'propagation',
  'outbox',
  'tasks',
  'calls',
  'contexts',
  'receipts',
  'processing',
  'receiving_batches',
  'foundations',
  'persona_links',
  'personas',
  'drafts',
  'messages',
] as const;
/** v1 的阶段编号保持不变，v2 在擦除原文前清理新增派生模块。 */
const LIFECYCLE_STAGES_V2 = [
  ...LIFECYCLE_STAGES_V1.slice(0, 6),
  'memory_versions',
  'memory_requeue',
  'memory_evidence',
  'memory_batches',
  ...LIFECYCLE_STAGES_V1.slice(6),
] as const;
/** v3 在原清理前传播跨会话回忆，增加词法与外部向量清理。 */
const LIFECYCLE_STAGES_V3 = [
  'recall_propagation',
  ...LIFECYCLE_STAGES_V2.slice(0, 8),
  'search_terms',
  'vector_points',
  ...LIFECYCLE_STAGES_V2.slice(8),
] as const;
/** v4 追加头像文件阶段，不改变 v1–v3 的检查点含义。 */
export const LIFECYCLE_STAGES = [...LIFECYCLE_STAGES_V3, 'avatar_files'] as const;
/**
 * 获取指定生命周期协议的清理阶段列表。
 *
 * 按操作创建时的协议恢复，升级不能重解释旧检查点。
 */
export function lifecycleStages(version: number): readonly string[] {
  if (version === 1) return LIFECYCLE_STAGES_V1;
  if (version === 2) return LIFECYCLE_STAGES_V2;
  if (version === 3) return LIFECYCLE_STAGES_V3;
  if (version === 4) return LIFECYCLE_STAGES;
  throw new Error('不支持的生命周期协议版本。');
}
/** 阶段输入只有目标身份，禁止把被删除正文写入日志或新任务。 */
export type LifecycleRecord = typeof lifecycleOperations.$inferSelect;
/** 每批只报告已提交数量和是否完成，失败时与进度一起回滚。 */
export interface CleanupPage {
  done: boolean;
  changed: number;
}
/** 领域模块接入同一协议；外部索引/文件阶段不得持数据库事务访问网络。 */
export type LifecycleCleanupPage = (
  ownerId: string,
  tx: DatabaseTransaction,
  operation: LifecycleRecord,
  limit: number,
) => Promise<CleanupPage>;

/**
 * 执行生命周期任务当前阶段的一页数据清理。
 *
 * 当前模块的分批清理；所有派生数据只按明确作用域处理。
 */
export const cleanupLifecyclePage: LifecycleCleanupPage = async (ownerId, tx, operation, limit) => {
  const content = operation.kind === 'delete_messages';
  /** 生成当前清理操作的查询范围条件。 */
  const scope = (value: unknown): SQL =>
    content
      ? lifecycleConversationScope(
          sql`JSON_UNQUOTE(JSON_EXTRACT(${value}, '$.conversationId'))`,
          operation,
        )
      : sql`JSON_UNQUOTE(JSON_EXTRACT(${value}, '$.companionId')) = ${operation.companionId} AND CAST(JSON_UNQUOTE(JSON_EXTRACT(${value}, '$.runtimeEpoch')) AS UNSIGNED) <= ${operation.previousEpoch}`;
  const targetIds = tx.sql
    .select({ id: lifecycleMessageTargets.messageId })
    .from(lifecycleMessageTargets)
    .where(
      and(
        eq(lifecycleMessageTargets.ownerId, ownerId),
        eq(lifecycleMessageTargets.operationId, operation.id),
      ),
    );
  const stage = lifecycleStages(operation.protocolVersion)[operation.stage];
  if (stage === 'search_terms') return cleanupSearchPage(ownerId, tx, operation, limit);
  if (stage === 'recall_propagation') {
    const memory = await propagateRecallDeletion(ownerId, tx, operation, limit);
    const originals = await cleanupLifecyclePage(
      ownerId,
      tx,
      { ...operation, stage: LIFECYCLE_STAGES.indexOf('propagation') },
      limit,
    );
    return {
      done: memory.done && originals.changed === 0,
      changed: memory.changed + originals.changed,
    };
  }
  if (stage?.startsWith('memory_')) return cleanupMemoryPage(ownerId, tx, operation, stage, limit);
  const now = new Date();
  if (stage === 'propagation') {
    if (!content) return { done: true, changed: 0 };
    const source = alias(lifecycleMessageTargets, 'source_target');
    const known = alias(lifecycleMessageTargets, 'known_target');
    const refs = await tx.sql
      .selectDistinct({ messageId: messages.id, contentVersion: messages.contentVersion })
      .from(source)
      .innerJoin(
        messageSources,
        and(
          eq(messageSources.ownerId, ownerId),
          eq(messageSources.sourceMessageId, source.messageId),
          eq(messageSources.sourceContentVersion, source.contentVersion),
        ),
      )
      .innerJoin(messages, eq(messages.id, messageSources.messageId))
      .leftJoin(
        known,
        and(
          eq(known.ownerId, ownerId),
          eq(known.operationId, operation.id),
          eq(known.messageId, messages.id),
        ),
      )
      .where(
        and(eq(source.ownerId, ownerId), eq(source.operationId, operation.id), isNull(known.id)),
      )
      .limit(limit);
    if (refs.length)
      await tx.sql.insert(lifecycleMessageTargets).values(
        refs.map((ref) => ({
          ...ref,
          ownerId,
          operationId: operation.id,
          kind: 'derived' as const,
        })),
      );
    const replies = await tx.sql
      .selectDistinct({ messageId: messages.id, contentVersion: messages.contentVersion })
      .from(source)
      .innerJoin(
        chatRunSources,
        and(
          eq(chatRunSources.ownerId, ownerId),
          eq(chatRunSources.messageId, source.messageId),
          eq(chatRunSources.contentVersion, source.contentVersion),
        ),
      )
      .innerJoin(chatSegments, eq(chatSegments.runId, chatRunSources.runId))
      .innerJoin(messages, eq(messages.id, chatSegments.messageId))
      .leftJoin(
        known,
        and(
          eq(known.ownerId, ownerId),
          eq(known.operationId, operation.id),
          eq(known.messageId, messages.id),
        ),
      )
      .where(
        and(eq(source.ownerId, ownerId), eq(source.operationId, operation.id), isNull(known.id)),
      )
      .limit(limit);
    if (replies.length)
      await tx.sql.insert(lifecycleMessageTargets).values(
        replies.map((ref) => ({
          ...ref,
          ownerId,
          operationId: operation.id,
          kind: 'derived' as const,
        })),
      );
    return { done: refs.length + replies.length === 0, changed: refs.length + replies.length };
  }
  if (stage === 'outbox') {
    const rows = await tx.taskOutbox.findMany({
      where: content
        ? and(
            inArray(taskOutbox.sourceId, targetIds),
            sql`JSON_LENGTH(JSON_EXTRACT(${taskOutbox.payload}, '$.recipients')) > 0`,
          )
        : sql`JSON_CONTAINS(${taskOutbox.payload}, JSON_OBJECT('companionId', ${operation.companionId}, 'runtimeEpoch', ${operation.previousEpoch}), '$.recipients')`,
      orderBy: [asc(taskOutbox.id)],
      limit: limit,
    });
    for (const row of rows) {
      const recipients = content
        ? []
        : row.payload.recipients.filter(
            (item) =>
              item.companionId !== operation.companionId ||
              item.runtimeEpoch > operation.previousEpoch!,
          );
      await tx.taskOutbox.updateWhere({
        where: { id: row.id },
        set: {
          payload: { ...row.payload, recipients },
          ...(recipients.length ? {} : { status: 'blocked' as const, reason: 'lifecycle_changed' }),
        },
      });
    }
    return { done: rows.length < limit, changed: rows.length };
  }
  if (stage === 'tasks') {
    const rows = await tx.tasks.findMany({
      where: and(
        scope(tasks.scope),
        sql`JSON_UNQUOTE(JSON_EXTRACT(${tasks.input}, '$.kind')) <> 'redacted'`,
      ),
      orderBy: [asc(tasks.id)],
      limit: limit,
    });
    for (const row of rows) {
      if (row.status === 'running')
        await tx.taskAttempts.updateWhere({
          where: { taskId: row.id, status: 'running' },
          set: { status: 'cancelled', reason: 'lifecycle_changed', finishedAt: now },
        });
      await tx.tasks.updateWhere({
        where: { id: row.id },
        set: {
          input: { kind: 'redacted' },
          status: ['succeeded', 'failed', 'cancelled'].includes(row.status)
            ? row.status
            : 'cancelled',
          reason: 'lifecycle_changed',
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        },
      });
    }
    return { done: rows.length < limit, changed: rows.length };
  }
  if (stage === 'calls') {
    const rows = await tx.modelCalls.findMany({
      where: and(scope(modelCalls.context), isNull(modelCalls.invalidatedAt)),
      fields: { id: modelCalls.id },
      orderBy: [asc(modelCalls.id)],
      limit: limit,
    });
    if (rows.length)
      await tx.modelCalls.updateWhere({
        where: inArray(
          modelCalls.id,
          rows.map((row) => row.id),
        ),
        set: {
          result: null,
          invalidatedAt: now,
          status: sql`CASE WHEN ${modelCalls.status} = 'running' THEN 'cancelled' ELSE ${modelCalls.status} END`,
        },
      });
    return { done: rows.length < limit, changed: rows.length };
  }
  if (stage === 'contexts') {
    const rows = await tx.sql
      .select({ id: chatRuns.id })
      .from(chatRuns)
      .innerJoin(chatThreads, eq(chatThreads.conversationId, chatRuns.conversationId))
      .where(
        and(
          eq(chatRuns.ownerId, ownerId),
          content
            ? lifecycleConversationScope(chatRuns.conversationId, operation)
            : and(
                eq(chatThreads.companionId, operation.companionId!),
                lte(chatThreads.runtimeEpoch, operation.previousEpoch!),
              ),
          isNotNull(chatRuns.context),
        ),
      )
      .orderBy(asc(chatRuns.id))
      .limit(limit);
    if (rows.length)
      await tx.chatRuns.updateWhere({
        where: inArray(
          chatRuns.id,
          rows.map((row) => row.id),
        ),
        set: { context: null, interruptedAt: now },
      });
    return { done: rows.length < limit, changed: rows.length };
  }
  if (
    stage === 'receipts' ||
    stage === 'processing' ||
    stage === 'receiving_batches' ||
    stage === 'foundations' ||
    stage === 'persona_links' ||
    stage === 'personas'
  ) {
    if (content && stage !== 'receipts' && stage !== 'processing')
      return { done: true, changed: 0 };
    const table =
      stage === 'receipts'
        ? readReceipts
        : stage === 'processing'
          ? processingRanges
          : stage === 'receiving_batches'
            ? receiveBatches
            : stage === 'foundations'
              ? personaFoundations
              : personaVersions;
    const rows = await tx.sql
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.ownerId, ownerId),
          content
            ? inArray(
                stage === 'receipts' ? readReceipts.messageId : processingRanges.messageId,
                targetIds,
              )
            : and(
                eq(table.companionId, operation.companionId!),
                lte(table.runtimeEpoch, operation.previousEpoch!),
              ),
          stage === 'persona_links' ? isNotNull(personaVersions.parentVersionId) : undefined,
        ),
      )
      .orderBy(asc(table.id))
      .limit(limit);
    if (rows.length) {
      if (stage === 'persona_links')
        await tx.sql
          .update(personaVersions)
          .set({ parentVersionId: null })
          .where(
            inArray(
              personaVersions.id,
              rows.map((row) => row.id),
            ),
          );
      else
        await tx.sql.delete(table).where(
          inArray(
            table.id,
            rows.map((row) => row.id),
          ),
        );
    }
    return { done: rows.length < limit, changed: rows.length };
  }
  if (stage === 'drafts' || stage === 'messages') {
    if ((stage === 'drafts') === content) return { done: true, changed: 0 };
    const memberships = tx.sql
      .select({ id: conversationMembers.id })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.ownerId, ownerId),
          eq(conversationMembers.companionId, operation.companionId!),
          lte(conversationMembers.runtimeEpoch, operation.previousEpoch!),
        ),
      );
    const rows = await tx.messages.findMany({
      where: and(
        isNull(messages.deletedAt),
        content
          ? inArray(messages.id, targetIds)
          : and(eq(messages.state, 'draft'), inArray(messages.speakerMembershipId, memberships)),
      ),
      fields: { id: messages.id },
      orderBy: [asc(messages.id)],
      limit: limit,
    });
    if (rows.length)
      await tx.messages.updateWhere({
        where: inArray(
          messages.id,
          rows.map((row) => row.id),
        ),
        set: { text: '', deletedAt: now },
      });
    return { done: rows.length < limit, changed: rows.length };
  }
  throw new Error('未注册的生命周期阶段');
};
