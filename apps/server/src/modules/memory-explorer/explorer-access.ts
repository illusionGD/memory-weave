import { and, eq, isNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { MemoryExplorerScope } from '@memory-weave/contracts';
import type { DatabaseTransaction } from '../../database/database.service';
import { memoryEntries, conversations, conversationMembers } from '../../database/schema';
import { requireCompanion, requireCompanionMember } from '../conversations/conversation-access';

/** 查询范围始终以实例为中心；跨会话只允许本用户与本实例之间的私聊。 */
export async function explorerScope(
  ownerId: string,
  companionId: string,
  query: MemoryExplorerScope,
  tx: DatabaseTransaction,
): Promise<SQL> {
  await requireCompanion(ownerId, companionId, query.runtimeEpoch, tx);
  if (query.conversationId)
    await requireCompanionMember(
      ownerId,
      companionId,
      query.runtimeEpoch,
      query.conversationId,
      tx,
    );
  return and(
    eq(memoryEntries.ownerId, ownerId),
    eq(memoryEntries.companionId, companionId),
    eq(memoryEntries.runtimeEpoch, query.runtimeEpoch),
    eq(conversations.ownerId, ownerId),
    isNull(conversations.lifecycleOperationId),
    sql`EXISTS (${tx
      .select({ id: conversationMembers.id })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.ownerId, ownerId),
          eq(conversationMembers.conversationId, conversations.id),
          eq(conversationMembers.companionId, companionId),
          eq(conversationMembers.runtimeEpoch, query.runtimeEpoch),
          eq(conversationMembers.kind, 'companion'),
          isNull(conversationMembers.deletedAt),
        ),
      )})`,
    query.conversationId
      ? eq(conversations.id, query.conversationId)
      : sql`(
      ${conversations.kind} = 'private'
      AND EXISTS (SELECT 1 FROM conversation_members u WHERE u.owner_id = ${ownerId} AND u.conversation_id = ${conversations.id} AND u.kind = 'user' AND u.user_id = ${ownerId})
      AND NOT EXISTS (SELECT 1 FROM conversation_members m WHERE m.owner_id = ${ownerId} AND m.conversation_id = ${conversations.id} AND NOT ((m.kind = 'user' AND m.user_id = ${ownerId}) OR (m.kind = 'companion' AND m.companion_id = ${companionId} AND m.runtime_epoch = ${query.runtimeEpoch})))
    )`,
  )!;
}
