import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { RecallResult, TaskScope } from '@memory-weave/contracts';
import { API_CODES } from '@memory-weave/contracts';
import type { DatabaseTransaction } from '../../database/database.service';
import { conversations, memoryEntries, memoryVersions, messages } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { assertVisible, requireCompanionMember } from '../conversations/conversation-access';
import { assertVersionSources } from '../memories/memory-records';
import { recallConversationScope } from './retrieval-access';

/** 来源受限或当前版本变化时旧上下文停止派发和发布，不能仅依赖向量过滤。 */
export async function validateRecallSnapshot(
  ownerId: string,
  scope: TaskScope,
  result: RecallResult,
  tx: DatabaseTransaction,
): Promise<void> {
  const filter = await recallConversationScope(
    ownerId,
    scope.companionId!,
    scope.runtimeEpoch!,
    scope.conversationId!,
    tx,
  );
  const ids = [
    ...new Set([
      ...result.pending.map((s) => s.conversationId),
      ...(result.querySources ?? []).map((s) => s.conversationId),
      ...result.memories.map((m) => m.conversationId),
    ]),
  ];
  if (ids.length) {
    const allowed = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.ownerId, ownerId),
          inArray(conversations.id, ids),
          isNull(conversations.lifecycleOperationId),
          filter,
        ),
      );
    if (allowed.length !== ids.length) throw new ApiException(API_CODES.LIFECYCLE_RESTRICTED);
  }
  for (const source of [...result.pending, ...(result.querySources ?? [])]) {
    const member = await requireCompanionMember(
      ownerId,
      scope.companionId!,
      scope.runtimeEpoch!,
      source.conversationId,
      tx,
    );
    if (member.permissionVersion !== source.permissionVersion)
      throw new ApiException(API_CODES.PERMISSION_VERSION_CONFLICT);
    await assertVisible(member, source.sequence, tx);
    const [row] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.ownerId, ownerId),
          eq(messages.id, source.messageId),
          eq(messages.conversationId, source.conversationId),
          eq(messages.contentVersion, source.contentVersion),
          eq(messages.state, 'published'),
          isNull(messages.deletedAt),
        ),
      );
    if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
  }
  for (const item of result.memories) {
    const [row] = await tx
      .select({ entry: memoryEntries, version: memoryVersions })
      .from(memoryEntries)
      .innerJoin(memoryVersions, eq(memoryVersions.memoryId, memoryEntries.id))
      .where(
        and(
          eq(memoryEntries.ownerId, ownerId),
          eq(memoryEntries.id, item.id),
          eq(memoryEntries.companionId, scope.companionId!),
          eq(memoryEntries.runtimeEpoch, scope.runtimeEpoch!),
          eq(memoryVersions.id, item.versionId),
          isNull(memoryVersions.invalidatedAt),
        ),
      );
    if (
      !row?.version.document ||
      row.entry.status === 'invalidated' ||
      (item.current && row.entry.currentVersionId !== item.versionId)
    )
      throw new ApiException(API_CODES.VERSION_CONFLICT);
    await assertVersionSources(ownerId, row.entry, row.version, tx);
  }
}
