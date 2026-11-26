import { API_CODES } from '@memory-weave/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { DatabaseService, DatabaseTransaction } from '../../database/database.service';
import { autonomyPolicies } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { requireCompanionMember } from '../conversations/conversation-access';
import { activeMemberships, requireOpenConversation } from '../conversations/membership-store';

export type Policy = typeof autonomyPolicies.$inferSelect;

/** 读取已持久的当前用户设置，旧版本不能复活授权。 */
export async function currentAutonomyPolicy(
  ownerId: string,
  companionId: string,
  runtimeEpoch: number,
  tx: DatabaseTransaction,
) {
  const [row] = await tx
    .select()
    .from(autonomyPolicies)
    .where(
      and(
        eq(autonomyPolicies.ownerId, ownerId),
        eq(autonomyPolicies.companionId, companionId),
        eq(autonomyPolicies.runtimeEpoch, runtimeEpoch),
      ),
    )
    .orderBy(desc(autonomyPolicies.version))
    .limit(1);
  return row;
}

/** 自主联系只使用双方仍在的已选择私聊。 */
export async function requireAutonomyScope(
  database: DatabaseService,
  policy: Pick<Policy, 'ownerId' | 'companionId' | 'runtimeEpoch' | 'conversationId'>,
  tx: DatabaseTransaction,
) {
  const { ownerId, conversationId, companionId, runtimeEpoch } = policy;
  const conversation = await requireOpenConversation(ownerId, conversationId, tx);
  const member = await requireCompanionMember(
    database,
    ownerId,
    companionId,
    runtimeEpoch,
    conversationId,
    tx,
  );
  const members = await activeMemberships(ownerId, conversationId, tx);
  const user = members.find((row) => row.kind === 'user');
  if (conversation.kind !== 'private' || !user || member.leftSequence !== null || member.deletedAt)
    throw new ApiException(API_CODES.ACCESS_DENIED);
  return { conversation, member, user };
}

/** 作用域已经关闭或迁移时允许其他伴侣继续调度。 */
export function autonomyScopeUnavailable(error: unknown): boolean {
  return (
    error instanceof ApiException &&
    [
      API_CODES.RESOURCE_NOT_FOUND,
      API_CODES.ACCESS_DENIED,
      API_CODES.CONVERSATION_CLOSED,
      API_CODES.RUNTIME_EPOCH_MISMATCH,
      API_CODES.LIFECYCLE_RESTRICTED,
    ].some((code) => code === error.code)
  );
}
