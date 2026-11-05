import type { DatabaseService } from '../../database/database.service';
import type { SQL } from 'drizzle-orm';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import type { DatabaseTransaction } from '../../database/database.service';
import { conversationMembers, conversations } from '../../database/schema';
import { requireCompanionMember } from '../conversations/conversation-access';

/**
 * 构建记忆检索可访问的会话范围。
 *
 * 首版跨会话只开放同一用户与本实例的私聊，群聊只使用本会话。
 */
export async function recallConversationScope(
  database: DatabaseService,
  ownerId: string,
  companionId: string,
  runtimeEpoch: number,
  conversationId: string,
  tx: DatabaseTransaction,
): Promise<SQL> {
  await requireCompanionMember(database, ownerId, companionId, runtimeEpoch, conversationId, tx);
  const target = await database.conversations.findById(ownerId, conversationId, tx);
  const user = await database.conversationMembers.findOne(
    ownerId,
    {
      where: { conversationId, kind: 'user', userId: ownerId },
    },
    tx,
  );
  if (target?.kind !== 'private' || !user) return sql`${conversations.id} = ${conversationId}`;
  const member = alias(conversationMembers, 'recall_member');
  const other = alias(conversationMembers, 'recall_other');
  return sql`(${conversations.id} = ${conversationId} OR (
    ${conversations.kind} = 'private' AND EXISTS (${tx
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.ownerId, ownerId),
          eq(member.conversationId, conversations.id),
          eq(member.companionId, companionId),
          eq(member.runtimeEpoch, runtimeEpoch),
          isNull(member.deletedAt),
        ),
      )}) AND NOT EXISTS (${tx
      .select({ id: other.id })
      .from(other)
      .where(
        and(
          eq(other.conversationId, conversations.id),
          sql`NOT ((${other.kind} = 'user' AND ${other.userId} = ${ownerId}) OR (${other.kind} = 'companion' AND ${other.companionId} = ${companionId} AND ${other.runtimeEpoch} = ${runtimeEpoch}))`,
        ),
      )})
  ))`;
}
