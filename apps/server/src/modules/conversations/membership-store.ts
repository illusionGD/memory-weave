import { API_CODES } from '@memory-weave/contracts';
import { and, asc, eq, exists, inArray, isNull, notExists, or, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  companions,
  conversationHistoryShares,
  conversationMembers,
  conversationMembershipCommands,
  conversations,
  processingRanges,
  visibilityGrants,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { requireConversation } from './conversation-access';
import { closeMembershipRange, mergeMembershipRanges } from './membership-ranges';
import type { SequenceRange } from './membership-ranges';

export type MemberRow = typeof conversationMembers.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
type CommandResult = typeof conversationMembershipCommands.$inferSelect.result;

/** 会话关闭后仍可读历史，新的发言、邀请和授权写入必须单独校验。 */
export async function requireOpenConversation(
  ownerId: string,
  id: string,
  tx: DatabaseTransaction,
): Promise<ConversationRow> {
  const conversation = await requireConversation(ownerId, id, tx, true);
  if (conversation.closedAt) throw new ApiException(API_CODES.CONVERSATION_CLOSED);
  return conversation;
}

/** 读取并校验准确会话中的成员身份。 */
export async function membership(
  ownerId: string,
  conversationId: string,
  id: string,
  tx: DatabaseTransaction,
): Promise<MemberRow> {
  const [row] = await tx
    .select()
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.ownerId, ownerId),
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.id, id),
        isNull(conversationMembers.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
  return row;
}

/** 读取当前活动成员，不把已退出成员加入新会话。 */
export async function activeMemberships(
  ownerId: string,
  conversationId: string,
  tx: DatabaseTransaction,
): Promise<MemberRow[]> {
  const rows = await tx
    .select({ member: conversationMembers })
    .from(conversationMembers)
    .leftJoin(
      companions,
      and(
        eq(companions.ownerId, ownerId),
        eq(companions.id, conversationMembers.companionId),
        eq(companions.runtimeEpoch, conversationMembers.runtimeEpoch),
        isNull(companions.deletedAt),
        isNull(companions.lifecycleOperationId),
      ),
    )
    .where(
      and(
        eq(conversationMembers.ownerId, ownerId),
        eq(conversationMembers.conversationId, conversationId),
        isNull(conversationMembers.deletedAt),
        isNull(conversationMembers.leftSequence),
        or(eq(conversationMembers.kind, 'user'), sql`${companions.id} IS NOT NULL`),
      ),
    )
    .orderBy(asc(conversationMembers.id))
    .limit(21);
  return rows.map(({ member }) => member);
}

/** 幂等重放原操作结果，不再次改变成员状态。 */
export async function replayMembershipCommand<T extends CommandResult>(
  ownerId: string,
  conversationId: string,
  id: string,
  hash: string,
  tx: DatabaseTransaction,
): Promise<T | undefined> {
  const [saved] = await tx
    .select()
    .from(conversationMembershipCommands)
    .where(
      and(
        eq(conversationMembershipCommands.ownerId, ownerId),
        eq(conversationMembershipCommands.requestId, id),
      ),
    )
    .limit(1);
  if (!saved) return undefined;
  if (saved.conversationId !== conversationId || saved.fingerprint !== hash)
    throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
  return saved.result as T;
}

/** 将成员操作与其可重复返回的结果写入同一事务。 */
export async function saveMembershipCommand<T extends CommandResult>(
  ownerId: string,
  conversationId: string,
  id: string,
  hash: string,
  result: T,
  now: Date,
  tx: DatabaseTransaction,
): Promise<T> {
  await tx.insert(conversationMembershipCommands).values({
    ownerId,
    conversationId,
    requestId: id,
    fingerprint: hash,
    result,
    createdAt: now,
  });
  return result;
}

/** 查询仍使用中的授权快照。 */
export function currentMembershipGrants(member: MemberRow, tx: DatabaseTransaction) {
  return tx
    .select()
    .from(visibilityGrants)
    .where(
      and(
        eq(visibilityGrants.ownerId, member.ownerId),
        eq(visibilityGrants.membershipId, member.id),
        eq(visibilityGrants.permissionVersion, member.permissionVersion),
      ),
    )
    .orderBy(asc(visibilityGrants.startSequence));
}

/** 更新权限后保留仍可实际读取的整理范围，拒绝使用旧权限版本的任务结果。 */
export async function refreshPendingRanges(
  member: MemberRow,
  tx: DatabaseTransaction,
): Promise<void> {
  if (!member.companionId || !member.runtimeEpoch) return;
  const inScope = and(
    eq(processingRanges.ownerId, member.ownerId),
    eq(processingRanges.companionId, member.companionId),
    eq(processingRanges.runtimeEpoch, member.runtimeEpoch),
    eq(processingRanges.conversationId, member.conversationId),
  );
  const visible = tx
    .select({ id: visibilityGrants.id })
    .from(visibilityGrants)
    .where(
      and(
        eq(visibilityGrants.ownerId, member.ownerId),
        eq(visibilityGrants.membershipId, member.id),
        eq(visibilityGrants.permissionVersion, member.permissionVersion),
        sql`${visibilityGrants.startSequence} <= ${processingRanges.startSequence}
      AND (${visibilityGrants.endSequence} IS NULL OR ${visibilityGrants.endSequence} >= ${processingRanges.endSequence})`,
      ),
    );
  await tx
    .update(processingRanges)
    .set({ status: 'pending', batchId: null })
    .where(and(inScope, eq(processingRanges.status, 'processing'), exists(visible)));
  await tx
    .delete(processingRanges)
    .where(
      and(inScope, inArray(processingRanges.status, ['pending', 'processing']), notExists(visible)),
    );
}

/** 依据实际成员边界和显式分享重新生成当前授权集合。 */
export async function rewriteMembershipGrants(
  member: MemberRow,
  changes: Partial<Pick<MemberRow, 'joinedSequence' | 'leftSequence' | 'removedAt'>>,
  tx: DatabaseTransaction,
): Promise<MemberRow> {
  if (member.permissionVersion >= 2_147_483_647)
    throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
  const existing = await currentMembershipGrants(member, tx);
  const next = { ...member, ...changes, permissionVersion: member.permissionVersion + 1 };
  const retained: SequenceRange[] = existing.filter((grant) => grant.kind === 'retained');
  if (changes.joinedSequence !== undefined && member.leftSequence !== null)
    retained.push(
      ...existing
        .filter((grant) => grant.kind === 'membership')
        .map((grant) => closeMembershipRange(grant, member.leftSequence!)),
    );
  const approved = await tx
    .select({
      startSequence: conversationHistoryShares.fromSequence,
      endSequence: conversationHistoryShares.throughSequence,
    })
    .from(conversationHistoryShares)
    .where(
      and(
        eq(conversationHistoryShares.ownerId, member.ownerId),
        eq(conversationHistoryShares.membershipId, member.id),
        eq(conversationHistoryShares.state, 'approved'),
      ),
    );
  const ranges: (SequenceRange & { kind: 'membership' | 'retained' | 'history' })[] = [
    ...mergeMembershipRanges(retained).map((range) => ({ ...range, kind: 'retained' as const })),
    ...mergeMembershipRanges(approved).map((range) => ({ ...range, kind: 'history' as const })),
  ];
  if (next.leftSequence === null || next.leftSequence >= next.joinedSequence)
    ranges.push({
      startSequence: next.joinedSequence,
      endSequence: next.leftSequence,
      kind: 'membership',
    });
  await tx
    .update(conversationMembers)
    .set({ ...changes, permissionVersion: next.permissionVersion })
    .where(
      and(eq(conversationMembers.ownerId, member.ownerId), eq(conversationMembers.id, member.id)),
    );
  if (ranges.length)
    await tx.insert(visibilityGrants).values(
      ranges.map((range) => ({
        ...range,
        ownerId: member.ownerId,
        membershipId: member.id,
        permissionVersion: next.permissionVersion,
      })),
    );
  await refreshPendingRanges(next, tx);
  return next;
}

/** 版本护栏使成员变化与消息发布按主库顺序提交。 */
export async function advanceConversation(
  row: ConversationRow,
  tx: DatabaseTransaction,
  changes: Partial<Pick<ConversationRow, 'closedAt' | 'peerInvitationsEnabled'>> = {},
): Promise<ConversationRow> {
  if (row.version >= 2_147_483_647) throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
  const updated = { ...row, ...changes, version: row.version + 1 };
  await tx
    .update(conversations)
    .set({ ...changes, version: updated.version })
    .where(and(eq(conversations.ownerId, row.ownerId), eq(conversations.id, row.id)));
  return updated;
}
