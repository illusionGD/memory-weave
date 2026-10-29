import { and, asc, eq, inArray, isNull, isNotNull, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  chatRuns,
  chatThreads,
  chatSegments,
  chatRunSources,
  conversationMembers,
  lifecycleOperations,
  lifecycleMessageTargets,
  messages,
  messageSources,
  modelCalls,
  personaFoundations,
  personaVersions,
  processingRanges,
  readReceipts,
  receiveBatches,
  tasks,
  taskAttempts,
  taskOutbox,
} from '../../database/schema';

/** 清理协议 v1 的有序阶段，新增派生模块必须增加自己的清理阶段与读取围栏。 */
export const LIFECYCLE_STAGES = [
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

/** 当前模块的分批清理；所有派生数据只按明确作用域处理。 */
export const cleanupLifecyclePage: LifecycleCleanupPage = async (ownerId, tx, operation, limit) => {
  const content = operation.kind === 'delete_messages';
  const scope = (value: unknown): SQL =>
    content
      ? sql`JSON_UNQUOTE(JSON_EXTRACT(${value}, '$.conversationId')) = ${operation.conversationId}`
      : sql`JSON_UNQUOTE(JSON_EXTRACT(${value}, '$.companionId')) = ${operation.companionId} AND CAST(JSON_UNQUOTE(JSON_EXTRACT(${value}, '$.runtimeEpoch')) AS UNSIGNED) <= ${operation.previousEpoch}`;
  const targetIds = tx
    .select({ id: lifecycleMessageTargets.messageId })
    .from(lifecycleMessageTargets)
    .where(
      and(
        eq(lifecycleMessageTargets.ownerId, ownerId),
        eq(lifecycleMessageTargets.operationId, operation.id),
      ),
    );
  const stage = LIFECYCLE_STAGES[operation.stage];
  const now = new Date();
  if (stage === 'propagation') {
    if (!content) return { done: true, changed: 0 };
    const source = alias(lifecycleMessageTargets, 'source_target');
    const known = alias(lifecycleMessageTargets, 'known_target');
    const refs = await tx
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
      await tx.insert(lifecycleMessageTargets).values(
        refs.map((ref) => ({
          ...ref,
          ownerId,
          operationId: operation.id,
          kind: 'derived' as const,
        })),
      );
    const replies = await tx
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
      await tx.insert(lifecycleMessageTargets).values(
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
    const rows = await tx
      .select()
      .from(taskOutbox)
      .where(
        and(
          eq(taskOutbox.ownerId, ownerId),
          content
            ? and(
                inArray(taskOutbox.sourceId, targetIds),
                sql`JSON_LENGTH(JSON_EXTRACT(${taskOutbox.payload}, '$.recipients')) > 0`,
              )
            : sql`JSON_CONTAINS(${taskOutbox.payload}, JSON_OBJECT('companionId', ${operation.companionId}, 'runtimeEpoch', ${operation.previousEpoch}), '$.recipients')`,
        ),
      )
      .orderBy(asc(taskOutbox.id))
      .limit(limit);
    for (const row of rows) {
      const recipients = content
        ? []
        : row.payload.recipients.filter(
            (item) =>
              item.companionId !== operation.companionId ||
              item.runtimeEpoch > operation.previousEpoch!,
          );
      await tx
        .update(taskOutbox)
        .set({
          payload: { ...row.payload, recipients },
          ...(recipients.length ? {} : { status: 'blocked' as const, reason: 'lifecycle_changed' }),
        })
        .where(eq(taskOutbox.id, row.id));
    }
    return { done: rows.length < limit, changed: rows.length };
  }
  if (stage === 'tasks') {
    const rows = await tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.ownerId, ownerId),
          scope(tasks.scope),
          sql`JSON_UNQUOTE(JSON_EXTRACT(${tasks.input}, '$.kind')) <> 'redacted'`,
        ),
      )
      .orderBy(asc(tasks.id))
      .limit(limit);
    for (const row of rows) {
      if (row.status === 'running')
        await tx
          .update(taskAttempts)
          .set({ status: 'cancelled', reason: 'lifecycle_changed', finishedAt: now })
          .where(
            and(
              eq(taskAttempts.ownerId, ownerId),
              eq(taskAttempts.taskId, row.id),
              eq(taskAttempts.status, 'running'),
            ),
          );
      await tx
        .update(tasks)
        .set({
          input: { kind: 'redacted' },
          status: ['succeeded', 'failed', 'cancelled'].includes(row.status)
            ? row.status
            : 'cancelled',
          reason: 'lifecycle_changed',
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(tasks.id, row.id));
    }
    return { done: rows.length < limit, changed: rows.length };
  }
  if (stage === 'calls') {
    const rows = await tx
      .select({ id: modelCalls.id })
      .from(modelCalls)
      .where(
        and(
          eq(modelCalls.ownerId, ownerId),
          scope(modelCalls.context),
          isNull(modelCalls.invalidatedAt),
        ),
      )
      .orderBy(asc(modelCalls.id))
      .limit(limit);
    if (rows.length)
      await tx
        .update(modelCalls)
        .set({
          result: null,
          invalidatedAt: now,
          status: sql`CASE WHEN ${modelCalls.status} = 'running' THEN 'cancelled' ELSE ${modelCalls.status} END`,
        })
        .where(
          inArray(
            modelCalls.id,
            rows.map((row) => row.id),
          ),
        );
    return { done: rows.length < limit, changed: rows.length };
  }
  if (stage === 'contexts') {
    const rows = await tx
      .select({ id: chatRuns.id })
      .from(chatRuns)
      .innerJoin(chatThreads, eq(chatThreads.conversationId, chatRuns.conversationId))
      .where(
        and(
          eq(chatRuns.ownerId, ownerId),
          content
            ? eq(chatRuns.conversationId, operation.conversationId!)
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
      await tx
        .update(chatRuns)
        .set({ context: null, interruptedAt: now })
        .where(
          inArray(
            chatRuns.id,
            rows.map((row) => row.id),
          ),
        );
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
    const rows = await tx
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
        await tx
          .update(personaVersions)
          .set({ parentVersionId: null })
          .where(
            inArray(
              personaVersions.id,
              rows.map((row) => row.id),
            ),
          );
      else
        await tx.delete(table).where(
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
    const memberships = tx
      .select({ id: conversationMembers.id })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.ownerId, ownerId),
          eq(conversationMembers.companionId, operation.companionId!),
          lte(conversationMembers.runtimeEpoch, operation.previousEpoch!),
        ),
      );
    const rows = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.ownerId, ownerId),
          isNull(messages.deletedAt),
          content
            ? inArray(messages.id, targetIds)
            : and(eq(messages.state, 'draft'), inArray(messages.speakerMembershipId, memberships)),
        ),
      )
      .orderBy(asc(messages.id))
      .limit(limit);
    if (rows.length)
      await tx
        .update(messages)
        .set({ text: '', deletedAt: now })
        .where(
          inArray(
            messages.id,
            rows.map((row) => row.id),
          ),
        );
    return { done: rows.length < limit, changed: rows.length };
  }
  throw new Error('未注册的生命周期阶段');
};
