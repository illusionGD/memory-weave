import { Inject, Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import { and, count, desc, eq, sum } from 'drizzle-orm';
import { SERVER_CONFIG } from '../../config';
import type { ServerConfig } from '../../config';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import { modelAttempts, peerSessionAttempts, peerSessions } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { AutonomyBudget } from '../autonomy/autonomy-budget';
import { peerConfigurationSchema } from './peer-config';
import type { PeerConfiguration } from './peer-config';
import { currentPeerPolicy, currentPeerRoom } from './peer-policy';

export type Session = typeof peerSessions.$inferSelect;

/** 实际派发必须同时通过实例共享额度、本场调用和本场费用。 */
@Injectable()
export class PeerBudget {
  readonly limits: Readonly<PeerConfiguration>;

  /** 初始化同伴特定的限制和沿用的自主计量。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AutonomyBudget) private readonly autonomy: AutonomyBudget,
    @Inject(SERVER_CONFIG) config: ServerConfig,
  ) {
    this.limits = peerConfigurationSchema.parse(config.peerConfiguration ?? {});
  }

  /** 查轮次实际自主场次。 */
  async session(
    ownerId: string,
    id: string,
    tx: DatabaseTransaction,
  ): Promise<Session | undefined> {
    const [row] = await tx
      .select()
      .from(peerSessions)
      .where(and(eq(peerSessions.ownerId, ownerId), eq(peerSessions.id, id)))
      .limit(1);
    return row;
  }

  /** 验证依然允许本位伴侣在本会话自动发言。 */
  async allowed(
    session: Session,
    companionId: string,
    runtimeEpoch: number,
    tx: DatabaseTransaction,
  ): Promise<boolean> {
    if (!this.limits.enabled || session.reason) return false;
    const room = await currentPeerRoom(session.ownerId, session.conversationId, tx);
    if (!room?.enabled || room.version !== session.roomVersion) return false;
    return Boolean(
      (await currentPeerPolicy(session.ownerId, companionId, runtimeEpoch, tx))?.enabled,
    );
  }

  /** 校验和登记实际派发尝试，再恢复只读已有结果。 */
  async dispatch(
    session: Session,
    companionId: string,
    runtimeEpoch: number,
    requestId: string,
    tx: DatabaseTransaction,
  ): Promise<void> {
    const { ownerId } = session;
    const current = await this.session(ownerId, session.id, tx);
    if (!current || !(await this.allowed(current, companionId, runtimeEpoch, tx)))
      throw new ApiException(API_CODES.PERMISSION_VERSION_CONFLICT);
    const call = await this.database.modelCalls.findOne(ownerId, { where: { requestId } }, tx);
    if (call && call.status !== 'running') return;
    const [attempt] = call
      ? await tx
          .select({ number: modelAttempts.number, charged: modelAttempts.chargedCostMicros })
          .from(modelAttempts)
          .where(
            and(
              eq(modelAttempts.ownerId, ownerId),
              eq(modelAttempts.callId, call.id),
              eq(modelAttempts.status, 'running'),
            ),
          )
          .orderBy(desc(modelAttempts.number))
          .limit(1)
      : [];
    if (call && attempt) {
      const [replay] = await tx
        .select({ number: peerSessionAttempts.attempt })
        .from(peerSessionAttempts)
        .where(
          and(
            eq(peerSessionAttempts.ownerId, ownerId),
            eq(peerSessionAttempts.sessionId, session.id),
            eq(peerSessionAttempts.callId, call.id),
            eq(peerSessionAttempts.attempt, attempt.number),
          ),
        )
        .limit(1);
      if (replay) return;
    }
    const used = await this.usage(ownerId, session.id, tx);
    if (
      used.calls >= session.maxCalls ||
      used.chargedMicros + (attempt?.charged ?? 0) > session.maxCostMicros
    )
      throw new ApiException(API_CODES.PEER_SESSION_LIMIT);
    await this.autonomy.model(ownerId, companionId, requestId, tx);
    if (call && attempt)
      await tx
        .insert(peerSessionAttempts)
        .values({ ownerId, sessionId: session.id, callId: call.id, attempt: attempt.number });
  }

  /** 使用 F03 已知用量和仍需保留的预留统计本场费用。 */
  async usage(ownerId: string, id: string, tx: DatabaseTransaction) {
    const [row] = await tx
      .select({ calls: count(), charged: sum(modelAttempts.chargedCostMicros) })
      .from(peerSessionAttempts)
      .innerJoin(
        modelAttempts,
        and(
          eq(modelAttempts.ownerId, ownerId),
          eq(modelAttempts.callId, peerSessionAttempts.callId),
          eq(modelAttempts.number, peerSessionAttempts.attempt),
        ),
      )
      .where(and(eq(peerSessionAttempts.ownerId, ownerId), eq(peerSessionAttempts.sessionId, id)));
    return { calls: Number(row?.calls ?? 0), chargedMicros: Number(row?.charged ?? 0) };
  }

  /** 停止本场新生成，保留成员身份及已有发言。 */
  async reason(ownerId: string, id: string, reason: string, tx: DatabaseTransaction) {
    await tx
      .update(peerSessions)
      .set({ reason })
      .where(and(eq(peerSessions.ownerId, ownerId), eq(peerSessions.id, id)));
  }
}
