import { Inject, Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import type {
  ConfigurePeer,
  ConfigurePeerRoom,
  IdPaginationQuery,
  PeerPolicy,
  PeerProfiles,
  PeerRoom,
} from '@memory-weave/contracts';
import { and, asc, desc, eq, gt, isNull, notExists } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import { companions, peerPolicies, peerRoomSettings } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { requireCompanion, requireConversation } from '../conversations/conversation-access';
import { requireOpenConversation } from '../conversations/membership-store';
import { fingerprint } from '../shared/http';
import { TaskStore } from '../tasks/task-store';

type Policy = typeof peerPolicies.$inferSelect;
type Room = typeof peerRoomSettings.$inferSelect;

/** 查询当前代次的同伴许可。 */
export async function currentPeerPolicy(
  ownerId: string,
  companionId: string,
  runtimeEpoch: number,
  tx: DatabaseTransaction,
) {
  const [row] = await tx
    .select()
    .from(peerPolicies)
    .where(
      and(
        eq(peerPolicies.ownerId, ownerId),
        eq(peerPolicies.companionId, companionId),
        eq(peerPolicies.runtimeEpoch, runtimeEpoch),
      ),
    )
    .orderBy(desc(peerPolicies.version))
    .limit(1);
  return row;
}

/** 查询当前会话的有效自主许可。 */
export async function currentPeerRoom(
  ownerId: string,
  conversationId: string,
  tx: DatabaseTransaction,
) {
  const [row] = await tx
    .select()
    .from(peerRoomSettings)
    .where(
      and(
        eq(peerRoomSettings.ownerId, ownerId),
        eq(peerRoomSettings.conversationId, conversationId),
      ),
    )
    .orderBy(desc(peerRoomSettings.version))
    .limit(1);
  return row;
}

/** 提供同一部署中允许发现的公开字段。 */
export async function peerProfiles(
  ownerId: string,
  query: IdPaginationQuery,
  tx: DatabaseTransaction,
): Promise<PeerProfiles> {
  const newer = alias(peerPolicies, 'newer_peer_policy');
  const rows = await tx
    .select({
      companionId: companions.id,
      runtimeEpoch: companions.runtimeEpoch,
      name: companions.name,
      description: peerPolicies.publicDescription,
    })
    .from(peerPolicies)
    .innerJoin(
      companions,
      and(
        eq(companions.ownerId, ownerId),
        eq(companions.id, peerPolicies.companionId),
        eq(companions.runtimeEpoch, peerPolicies.runtimeEpoch),
        isNull(companions.deletedAt),
        isNull(companions.lifecycleOperationId),
      ),
    )
    .where(
      and(
        eq(peerPolicies.ownerId, ownerId),
        eq(peerPolicies.enabled, true),
        query.afterId ? gt(companions.id, query.afterId) : undefined,
        notExists(
          tx
            .select({ version: newer.version })
            .from(newer)
            .where(
              and(
                eq(newer.ownerId, ownerId),
                eq(newer.companionId, peerPolicies.companionId),
                eq(newer.runtimeEpoch, peerPolicies.runtimeEpoch),
                gt(newer.version, peerPolicies.version),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(companions.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  return {
    items: page.map((row) => ({ ...row, description: row.description ?? '' })),
    nextAfterId: rows.length > query.limit ? page.at(-1)!.companionId : null,
  };
}

/** 用户可按实例和会话授予、撤销自主交流范围。 */
@Injectable()
export class PeerPolicyService {
  /** 初始化同伴设置和公开简介的存储。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
  ) {}

  /** 分页查看可发现的公开简介。 */
  profiles(ownerId: string, query: IdPaginationQuery): Promise<PeerProfiles> {
    return this.store.locked(ownerId, (tx) => peerProfiles(ownerId, query, tx));
  }

  /** 查看实际实例授权。 */
  settings(ownerId: string, id: string, runtimeEpoch: number): Promise<PeerPolicy | null> {
    return this.store.locked(ownerId, async (tx) => {
      await requireCompanion(this.database, ownerId, id, runtimeEpoch, tx);
      const row = await currentPeerPolicy(ownerId, id, runtimeEpoch, tx);
      return row ? policyView(row) : null;
    });
  }

  /** 更新公开简介、邀请决定和退出许可。 */
  configure(ownerId: string, id: string, command: ConfigurePeer): Promise<PeerPolicy> {
    const requestId = command.requestId.toLowerCase();
    const hash = fingerprint({ ...command, requestId });
    const { runtimeEpoch, enabled, publicDescription, invitationDecision, allowExit } = command;
    return this.store.locked(ownerId, async (tx, now) => {
      await requireCompanion(this.database, ownerId, id, runtimeEpoch, tx);
      const [replay] = await tx
        .select()
        .from(peerPolicies)
        .where(
          and(
            eq(peerPolicies.ownerId, ownerId),
            eq(peerPolicies.companionId, id),
            eq(peerPolicies.requestId, requestId),
          ),
        )
        .limit(1);
      if (replay) {
        if (replay.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return policyView(replay);
      }
      const current = await currentPeerPolicy(ownerId, id, runtimeEpoch, tx);
      const version = nextVersion(current?.version ?? 0, command.expectedVersion);
      await tx.insert(peerPolicies).values({
        ownerId,
        companionId: id,
        runtimeEpoch,
        version,
        enabled,
        publicDescription,
        invitationDecision,
        allowExit,
        requestId,
        fingerprint: hash,
        createdAt: now,
      });
      return { runtimeEpoch, version, enabled, publicDescription, invitationDecision, allowExit };
    });
  }

  /** 查看会话当前自主设置。 */
  room(ownerId: string, conversationId: string): Promise<PeerRoom | null> {
    return this.store.locked(ownerId, async (tx) => {
      await requireConversation(ownerId, conversationId, tx);
      const row = await currentPeerRoom(ownerId, conversationId, tx);
      return row ? roomView(row) : null;
    });
  }

  /** 用户打开或关闭指定会话的自主交流。 */
  configureRoom(
    ownerId: string,
    conversationId: string,
    command: ConfigurePeerRoom,
  ): Promise<PeerRoom> {
    const requestId = command.requestId.toLowerCase();
    const hash = fingerprint({ ...command, requestId });
    return this.store.locked(ownerId, async (tx, now) => {
      await requireConversation(ownerId, conversationId, tx);
      const [replay] = await tx
        .select()
        .from(peerRoomSettings)
        .where(
          and(
            eq(peerRoomSettings.ownerId, ownerId),
            eq(peerRoomSettings.conversationId, conversationId),
            eq(peerRoomSettings.requestId, requestId),
          ),
        )
        .limit(1);
      if (replay) {
        if (replay.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return roomView(replay);
      }
      if (command.enabled) await requireOpenConversation(ownerId, conversationId, tx);
      const current = await currentPeerRoom(ownerId, conversationId, tx);
      const version = nextVersion(current?.version ?? 0, command.expectedVersion);
      const { enabled, allowExit } = command;
      await tx.insert(peerRoomSettings).values({
        ownerId,
        conversationId,
        version,
        enabled,
        allowExit,
        requestId,
        fingerprint: hash,
        createdAt: now,
      });
      return { version, enabled, allowExit };
    });
  }
}

/** 校验预期版本并允许安全追加。 */
function nextVersion(current: number, expected: number): number {
  if (current !== expected) throw new ApiException(API_CODES.VERSION_CONFLICT);
  if (current >= 2_147_483_647) throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
  return current + 1;
}

/** 映射实际配置。 */
function policyView({
  runtimeEpoch,
  version,
  enabled,
  publicDescription,
  invitationDecision,
  allowExit,
}: Policy): PeerPolicy {
  return {
    runtimeEpoch,
    version,
    enabled,
    publicDescription: publicDescription ?? '',
    invitationDecision,
    allowExit,
  };
}

/** 映射实际会话配置。 */
function roomView({ version, enabled, allowExit }: Room): PeerRoom {
  return { version, enabled, allowExit };
}
