import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Conversation, ConversationMember, Message } from '@memory-weave/contracts';
import { and, asc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import type { Database, DatabaseTransaction } from '../../database/database.service';
import {
  companions,
  conversationMembers,
  conversations,
  messages,
  messageSources,
  visibilityGrants,
} from '../../database/schema';

/** 查询与事务共用的数据库接口，调用方负责事务边界。 */
export type QueryDatabase = Database | DatabaseTransaction;

/** 按部署归属取得会话，写入时可锁定共享顺序。 */
export async function requireConversation(
  ownerId: string,
  conversationId: string,
  db: QueryDatabase,
  lock = false,
): Promise<typeof conversations.$inferSelect> {
  const query = db
    .select()
    .from(conversations)
    .where(and(eq(conversations.ownerId, ownerId), eq(conversations.id, conversationId)))
    .limit(1);
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new NotFoundException('会话不存在或不可访问。');
  return row;
}

/** 校验实例归属及预期代次，不将过时代次替换为当前值。 */
export async function requireCompanion(
  ownerId: string,
  companionId: string,
  runtimeEpoch: number,
  db: QueryDatabase,
): Promise<typeof companions.$inferSelect> {
  const [row] = await db
    .select()
    .from(companions)
    .where(and(eq(companions.ownerId, ownerId), eq(companions.id, companionId)))
    .limit(1);
  if (!row) throw new NotFoundException('实例不存在或不可访问。');
  if (row.runtimeEpoch !== runtimeEpoch) throw new ConflictException('实例运行代次已变化。');
  return row;
}

/** 校验当前实例及其绑定相同代次的会话成员身份。 */
export async function requireCompanionMember(
  ownerId: string,
  companionId: string,
  runtimeEpoch: number,
  conversationId: string,
  db: QueryDatabase,
): Promise<typeof conversationMembers.$inferSelect> {
  await requireCompanion(ownerId, companionId, runtimeEpoch, db);
  const [member] = await db
    .select()
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.ownerId, ownerId),
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.companionId, companionId),
        eq(conversationMembers.runtimeEpoch, runtimeEpoch),
        eq(conversationMembers.kind, 'companion'),
      ),
    )
    .limit(1);
  if (!member) throw new NotFoundException('会话不存在或不可访问。');
  return member;
}

/** 校验确切发布序号的有效授权，历史授权与成员期间分别判断。 */
export async function assertVisible(
  member: typeof conversationMembers.$inferSelect,
  sequence: number,
  db: QueryDatabase,
): Promise<void> {
  const grants = await db
    .select()
    .from(visibilityGrants)
    .where(
      and(
        eq(visibilityGrants.ownerId, member.ownerId),
        eq(visibilityGrants.membershipId, member.id),
        eq(visibilityGrants.permissionVersion, member.permissionVersion),
        lte(visibilityGrants.startSequence, sequence),
        or(isNull(visibilityGrants.endSequence), gte(visibilityGrants.endSequence, sequence)),
      ),
    );
  const visible = grants.some(
    (grant) =>
      grant.kind === 'history' ||
      (sequence >= member.joinedSequence &&
        (member.leftSequence === null || sequence <= member.leftSequence)),
  );
  if (!visible) throw new NotFoundException('原文不存在或不可访问。');
}

/** 映射会话公共信息，内部幂等字段不进入响应。 */
export function toConversation(row: typeof conversations.$inferSelect): Conversation {
  return {
    id: row.id,
    ownerId: row.ownerId,
    kind: row.kind,
    title: row.title,
    version: row.version,
    lastSequence: row.lastSequence,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 映射互斥的用户或伴侣身份，拒绝不完整的持久成员记录。 */
export function toMember(row: typeof conversationMembers.$inferSelect): ConversationMember {
  const common = {
    id: row.id,
    ownerId: row.ownerId,
    conversationId: row.conversationId,
    joinedSequence: row.joinedSequence,
    leftSequence: row.leftSequence,
    permissionVersion: row.permissionVersion,
  };
  if (row.kind === 'user' && row.userId !== null) {
    return { ...common, kind: 'user', userId: row.userId, companionId: null, runtimeEpoch: null };
  }
  if (row.kind === 'companion' && row.companionId !== null && row.runtimeEpoch !== null) {
    return {
      ...common,
      kind: 'companion',
      userId: null,
      companionId: row.companionId,
      runtimeEpoch: row.runtimeEpoch,
    };
  }
  throw new ServiceUnavailableException('成员记录尚未就绪。');
}

/** 映射单份原文及来源，读取此方法不登记实际取得或整理状态。 */
export async function toMessage(
  row: typeof messages.$inferSelect,
  db: QueryDatabase,
): Promise<Message> {
  const [speakerRow] = await db
    .select()
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.ownerId, row.ownerId),
        eq(conversationMembers.id, row.speakerMembershipId),
        eq(conversationMembers.conversationId, row.conversationId),
      ),
    )
    .limit(1);
  if (!speakerRow) throw new ServiceUnavailableException('消息身份记录尚未就绪。');
  const member = toMember(speakerRow);
  const sourceRows = await db
    .select()
    .from(messageSources)
    .where(and(eq(messageSources.ownerId, row.ownerId), eq(messageSources.messageId, row.id)))
    .orderBy(asc(messageSources.sourceMessageId), asc(messageSources.relation));
  const common = {
    id: row.id,
    ownerId: row.ownerId,
    conversationId: row.conversationId,
    speakerMembershipId: row.speakerMembershipId,
    speaker:
      member.kind === 'user'
        ? { kind: 'user' as const, userId: member.userId }
        : {
            kind: 'companion' as const,
            companionId: member.companionId,
            runtimeEpoch: member.runtimeEpoch,
          },
    schemaVersion: 1 as const,
    contentVersion: row.contentVersion,
    revision: row.revision,
    text: row.text,
    occurredAt: row.occurredAt?.toISOString() ?? null,
    receivedAt: row.receivedAt.toISOString(),
    validFrom: row.validFrom?.toISOString() ?? null,
    validUntil: row.validUntil?.toISOString() ?? null,
    epistemicKind: row.epistemicKind,
    reality: row.reality,
    sourceKind: row.sourceKind,
    replyToMessageId: row.replyToMessageId,
    sources: sourceRows.map((source) => ({
      messageId: source.sourceMessageId,
      contentVersion: source.sourceContentVersion,
      relation: source.relation,
    })),
  };
  if (row.state === 'draft')
    return { ...common, state: 'draft', sequence: null, publishedAt: null };
  if (row.sequence === null || row.publishedAt === null)
    throw new ServiceUnavailableException('消息发布记录尚未就绪。');
  return {
    ...common,
    state: 'published',
    sequence: row.sequence,
    publishedAt: row.publishedAt.toISOString(),
  };
}
