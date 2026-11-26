import { Inject, Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import type {
  RelationshipHistory,
  RelationshipHistoryQuery,
  RelationshipList,
  RelationshipQuery,
  RelationshipState,
} from '@memory-weave/contracts';
import { and, asc, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  conversationMembers,
  messages,
  relationshipSources,
  relationshipStates,
  relationshipVersions,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { assertVisible, requireCompanionMember } from '../conversations/conversation-access';
import { TaskStore, taskDatabaseTime } from '../tasks/task-store';
import type { RelationshipContext } from '@memory-weave/contracts';

type State = typeof relationshipStates.$inferSelect;
type Version = typeof relationshipVersions.$inferSelect;
type Member = typeof conversationMembers.$inferSelect;

/** 读取独立关系视图，不能跨会话混合不同伴侣的方向。 */
@Injectable()
export class RelationshipService {
  /** 初始化关系状态查询。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
  ) {}

  /** 查询某个伴侣在同一会话里的当前状态。 */
  list(ownerId: string, companionId: string, query: RelationshipQuery): Promise<RelationshipList> {
    return this.store.locked(ownerId, async (tx, now) => {
      const member = await requireCompanionMember(
        this.database,
        ownerId,
        companionId,
        query.runtimeEpoch,
        query.conversationId,
        tx,
      );
      const rows = await tx
        .select({ state: relationshipStates, version: relationshipVersions })
        .from(relationshipStates)
        .innerJoin(
          relationshipVersions,
          and(
            eq(relationshipVersions.ownerId, ownerId),
            eq(relationshipVersions.stateId, relationshipStates.id),
            eq(relationshipVersions.version, relationshipStates.currentVersion),
          ),
        )
        .where(
          and(
            eq(relationshipStates.ownerId, ownerId),
            eq(relationshipStates.companionId, companionId),
            eq(relationshipStates.runtimeEpoch, query.runtimeEpoch),
            eq(relationshipStates.conversationId, query.conversationId),
            query.counterpartMembershipId
              ? eq(relationshipStates.counterpartMembershipId, query.counterpartMembershipId)
              : undefined,
            query.afterId ? gt(relationshipStates.id, query.afterId) : undefined,
          ),
        )
        .orderBy(asc(relationshipStates.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const items: RelationshipState[] = [];
      for (const { state, version } of page)
        items.push(await this.view(member, state, version, tx, now));
      return { items, nextAfterId: rows.length > query.limit ? page.at(-1)!.state.id : null };
    });
  }

  /** 查询一个方向及主题的历史版本。 */
  history(
    ownerId: string,
    companionId: string,
    id: string,
    query: RelationshipHistoryQuery,
  ): Promise<RelationshipHistory> {
    return this.store.locked(ownerId, async (tx, now) => {
      const [state] = await tx
        .select()
        .from(relationshipStates)
        .where(
          and(
            eq(relationshipStates.ownerId, ownerId),
            eq(relationshipStates.companionId, companionId),
            eq(relationshipStates.id, id),
          ),
        )
        .limit(1);
      if (!state) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      const member = await requireCompanionMember(
        this.database,
        ownerId,
        companionId,
        state.runtimeEpoch,
        state.conversationId,
        tx,
      );
      const rows = await tx
        .select()
        .from(relationshipVersions)
        .where(
          and(
            eq(relationshipVersions.ownerId, ownerId),
            eq(relationshipVersions.stateId, id),
            query.beforeVersion ? lt(relationshipVersions.version, query.beforeVersion) : undefined,
          ),
        )
        .orderBy(desc(relationshipVersions.version))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const items: RelationshipState[] = [];
      for (const version of page)
        items.push(await this.view(member, state, version, tx, now, true));
      return { items, nextBeforeVersion: rows.length > query.limit ? page.at(-1)!.version : null };
    });
  }

  /** 固定与当前用户对话有关且仍有依据的少量状态。 */
  async snapshot(
    member: Member,
    mode: 'test' | 'model',
    tx: DatabaseTransaction,
  ): Promise<RelationshipContext[]> {
    const ownerId = member.ownerId;
    const now = await taskDatabaseTime(this.database, ownerId, tx);
    const rows = await tx
      .select({ state: relationshipStates, version: relationshipVersions })
      .from(relationshipStates)
      .innerJoin(
        relationshipVersions,
        and(
          eq(relationshipVersions.ownerId, ownerId),
          eq(relationshipVersions.stateId, relationshipStates.id),
          eq(relationshipVersions.version, relationshipStates.currentVersion),
        ),
      )
      .innerJoin(
        conversationMembers,
        and(
          eq(conversationMembers.ownerId, ownerId),
          eq(conversationMembers.conversationId, member.conversationId),
          eq(conversationMembers.id, relationshipStates.counterpartMembershipId),
          eq(conversationMembers.kind, 'user'),
        ),
      )
      .where(
        and(
          eq(relationshipStates.ownerId, ownerId),
          eq(relationshipStates.companionId, member.companionId!),
          eq(relationshipStates.runtimeEpoch, member.runtimeEpoch!),
          eq(relationshipStates.conversationId, member.conversationId),
          eq(relationshipVersions.mode, mode),
          isNull(relationshipVersions.invalidatedAt),
          or(isNull(relationshipVersions.expiresAt), gt(relationshipVersions.expiresAt, now)),
        ),
      )
      .orderBy(desc(relationshipVersions.observedAt), asc(relationshipStates.id))
      .limit(3);
    const result: RelationshipContext[] = [];
    for (const { state, version } of rows) {
      const sources = await this.visibleSources(member, version, tx);
      if (!sources || !version.document) continue;
      result.push({
        stateId: state.id,
        version: version.version,
        kind: state.kind,
        topic: state.topic,
        document: version.document,
        observedAt: version.observedAt.toISOString(),
        sources,
      });
    }
    return result;
  }

  /** 派发及发布前重查固定版本的权限和来源。 */
  async validateSnapshot(
    member: Member,
    contexts: RelationshipContext[],
    tx: DatabaseTransaction,
  ): Promise<void> {
    const now = await taskDatabaseTime(this.database, member.ownerId, tx);
    for (const context of contexts) {
      const [version] = await tx
        .select({ row: relationshipVersions })
        .from(relationshipStates)
        .innerJoin(
          relationshipVersions,
          and(
            eq(relationshipVersions.ownerId, member.ownerId),
            eq(relationshipVersions.stateId, relationshipStates.id),
            eq(relationshipVersions.version, context.version),
          ),
        )
        .where(
          and(
            eq(relationshipStates.ownerId, member.ownerId),
            eq(relationshipStates.id, context.stateId),
            eq(relationshipStates.companionId, member.companionId!),
            eq(relationshipStates.conversationId, member.conversationId),
            eq(relationshipStates.runtimeEpoch, member.runtimeEpoch!),
          ),
        )
        .limit(1);
      if (
        !version?.row.document ||
        (version.row.expiresAt && version.row.expiresAt <= now) ||
        !(await this.visibleSources(member, version.row, tx))
      )
        throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    }
  }

  /** 确认该版本实际输入的所有原文仍可用于本伴侣。 */
  private async visibleSources(member: Member, version: Version, tx: DatabaseTransaction) {
    if (version.invalidatedAt || !version.document) return null;
    const rows = await tx
      .select({
        messageId: relationshipSources.messageId,
        contentVersion: relationshipSources.contentVersion,
        sequence: messages.sequence,
      })
      .from(relationshipSources)
      .leftJoin(
        messages,
        and(
          eq(messages.ownerId, member.ownerId),
          eq(messages.conversationId, member.conversationId),
          eq(messages.id, relationshipSources.messageId),
          eq(messages.contentVersion, relationshipSources.contentVersion),
          eq(messages.state, 'published'),
          isNull(messages.deletedAt),
        ),
      )
      .where(
        and(
          eq(relationshipSources.ownerId, member.ownerId),
          eq(relationshipSources.versionId, version.id),
        ),
      )
      .orderBy(asc(messages.sequence), asc(relationshipSources.messageId));
    if (!rows.length) return null;
    try {
      for (const { sequence } of rows) {
        if (sequence === null) return null;
        await assertVisible(member, sequence, tx);
      }
    } catch (error) {
      if (!(error instanceof ApiException) || error.code !== API_CODES.RESOURCE_NOT_FOUND)
        throw error;
      return null;
    }
    return rows.map(({ messageId, contentVersion }) => ({ messageId, contentVersion }));
  }

  /** 缺失依据和过期的短期感受不会继续进入当前视图。 */
  private async view(
    member: Member,
    state: State,
    version: Version,
    tx: DatabaseTransaction,
    now: Date,
    historical = false,
  ): Promise<RelationshipState> {
    const visible = await this.visibleSources(member, version, tx);
    const current = version.version === state.currentVersion;
    const expired = current && version.expiresAt !== null && version.expiresAt <= now;
    const status = !visible
      ? 'invalidated'
      : expired
        ? 'expired'
        : current
          ? 'current'
          : 'historical';
    const includeDocument = visible && (!expired || historical);
    return {
      id: state.id,
      companionId: state.companionId,
      runtimeEpoch: state.runtimeEpoch,
      conversationId: state.conversationId,
      counterpartMembershipId: state.counterpartMembershipId,
      kind: state.kind,
      topic: visible && !state.topic.startsWith('_') ? state.topic : 'redacted',
      version: version.version,
      currentVersion: state.currentVersion,
      status,
      document: includeDocument ? version.document : null,
      evidence: includeDocument ? (version.evidence ?? []) : [],
      mode: version.mode,
      observedAt: version.observedAt.toISOString(),
      expiresAt: version.expiresAt?.toISOString() ?? null,
      createdAt: version.createdAt.toISOString(),
    };
  }
}
