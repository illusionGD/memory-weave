import { LifecycleJournal } from '../lifecycle/lifecycle-journal';
import { API_CODES } from '@memory-weave/contracts';
import type {
  ConnectTerminal,
  IdPaginationQuery,
  RegisterTerminal,
  RequestTerminalAction,
  Terminal,
  TerminalAction,
  TerminalCapability,
  TerminalConnectionView,
  TerminalDispatch,
  TerminalGrant,
  TerminalReceipt,
  UpdateTerminalGrant,
} from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { SERVER_CONFIG } from '../../config';
import type { RuntimeConfig } from '../../config';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction, QueryDatabase } from '../../database/database.service';
import { messages, terminalActions, terminalGrants, terminals } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { assertVisible, requireCompanionMember } from '../conversations/conversation-access';
import { fingerprint } from '../shared/http';
import { TaskStore, taskDatabaseTime } from '../tasks/task-store';
import { terminalConfigurationSchema } from './terminal-config';
import type { TerminalConfiguration } from './terminal-config';

type TerminalRow = typeof terminals.$inferSelect;
type GrantRow = typeof terminalGrants.$inferSelect;
type ActionRow = typeof terminalActions.$inferSelect;
type Scope = Pick<GrantRow, 'conversationId' | 'companionId' | 'runtimeEpoch'>;
type ActionOrigin = ActionRow['requestedBy'];

const MAX_TERMINALS = 32;
const CLAIM_SCAN = 20;

@Injectable()
export class TerminalService {
  private readonly limits: TerminalConfiguration;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(SERVER_CONFIG) configuration: RuntimeConfig,
    @Inject(LifecycleJournal) private readonly journal: LifecycleJournal,
  ) {
    this.limits = configuration.terminalConfiguration ?? terminalConfigurationSchema.parse({});
  }

  /** 注册只允许创建或完全相同的重放，避免请求错把别的设备改成自己的设备。 */
  register(ownerId: string, id: string, input: RegisterTerminal): Promise<Terminal> {
    const secretHash = hashSecret(input.secret);
    return this.store.locked(ownerId, async (tx, now) => {
      const [current] = await tx.select().from(terminals).where(eq(terminals.id, id)).limit(1);
      if (current) {
        if (current.ownerId !== ownerId) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
        if (current.revokedAt || current.name !== input.name || current.secretHash !== secretHash)
          throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return terminalView(current, now);
      }
      const existing = await tx
        .select({ id: terminals.id })
        .from(terminals)
        .where(and(eq(terminals.ownerId, ownerId), isNull(terminals.revokedAt)))
        .limit(MAX_TERMINALS);
      if (existing.length >= MAX_TERMINALS)
        throw new ApiException(API_CODES.CONFLICT, '已达到活跃终端登记上限。');
      await tx.insert(terminals).values({ id, ownerId, name: input.name, secretHash });
      return terminalView(await this.terminal(ownerId, id, tx), now);
    });
  }

  /** 返回当前部署的设备登记及基于数据库时间的在线状态。 */
  list(
    ownerId: string,
    query: IdPaginationQuery,
  ): Promise<{ items: Terminal[]; nextAfterId: string | null }> {
    return this.store.locked(ownerId, async (tx, now) => {
      const rows = await tx
        .select()
        .from(terminals)
        .where(
          and(
            eq(terminals.ownerId, ownerId),
            query.afterId ? gt(terminals.id, query.afterId) : undefined,
          ),
        )
        .orderBy(asc(terminals.id))
        .limit(query.limit + 1);
      return {
        items: rows.slice(0, query.limit).map((row) => terminalView(row, now)),
        nextAfterId: rows.length > query.limit ? rows[query.limit - 1]!.id : null,
      };
    });
  }

  /** 终止凭据和在线能力。已发出的动作只能保留未知状态。 */
  revoke(ownerId: string, id: string): Promise<Terminal> {
    return this.store.locked(ownerId, async (tx, now) => {
      const current = await this.terminal(ownerId, id, tx);
      if (current.revokedAt) return terminalView(current, now);
      await this.markUnknown(current, tx);
      await tx
        .update(terminals)
        .set({ revokedAt: now, expiresAt: now, connectionId: null })
        .where(and(eq(terminals.ownerId, ownerId), eq(terminals.id, id)));
      await this.journal.append(ownerId, { kind: 'revoke_terminal', terminalId: current.id });
      return terminalView({ ...current, revokedAt: now }, now);
    });
  }

  /** 终端声明本轮环境；生成新的连接身份，过时连接的心跳和关闭请求均无效。 */
  connect(
    id: string,
    authorization: string | undefined,
    input: ConnectTerminal,
  ): Promise<TerminalConnectionView> {
    return this.withDevice(id, authorization, async (row, tx, now) => {
      await this.markUnknown(row, tx);
      const connectionId = randomUUID();
      const expiresAt = new Date(now.getTime() + this.limits.heartbeatTimeoutMs);
      await tx
        .update(terminals)
        .set({
          connectionId,
          workspaceId: input.workspaceId,
          capabilities: input.capabilities,
          lastHeartbeatAt: now,
          expiresAt,
        })
        .where(and(eq(terminals.ownerId, row.ownerId), eq(terminals.id, row.id)));
      return { connectionId, expiresAt: expiresAt.toISOString() };
    });
  }

  /** 心跳只续期当前连接，过期后需要显式重连。 */
  heartbeat(
    id: string,
    authorization: string | undefined,
    connectionId: string,
  ): Promise<TerminalConnectionView> {
    return this.withDevice(id, authorization, async (row, tx, now) => {
      this.requireConnection(row, connectionId, now);
      const expiresAt = new Date(now.getTime() + this.limits.heartbeatTimeoutMs);
      await tx
        .update(terminals)
        .set({ lastHeartbeatAt: now, expiresAt })
        .where(and(eq(terminals.ownerId, row.ownerId), eq(terminals.id, row.id)));
      return { connectionId: row.connectionId!, expiresAt: expiresAt.toISOString() };
    });
  }

  /** 正常退出立即下线，不把更近期的连接关闭。 */
  disconnect(id: string, authorization: string | undefined, connectionId: string): Promise<null> {
    return this.withDevice(id, authorization, async (row, tx, now) => {
      if (row.connectionId !== connectionId.toLowerCase())
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      await this.markUnknown(row, tx);
      await tx
        .update(terminals)
        .set({ expiresAt: now })
        .where(and(eq(terminals.ownerId, row.ownerId), eq(terminals.id, row.id)));
      return null;
    });
  }

  /** 只有已登录账号可授予动作能力，设备的声明不能写入授权。 */
  grant(ownerId: string, terminalId: string, input: UpdateTerminalGrant): Promise<TerminalGrant> {
    return this.store.locked(ownerId, async (tx) => {
      const terminal = await this.terminal(ownerId, terminalId, tx);
      if (input.enabled) {
        if (terminal.revokedAt) throw new ApiException(API_CODES.ACCESS_DENIED);
        await this.requireScope(ownerId, input, tx);
      }
      const scope = { ...input, terminalId: terminal.id };
      const current = await this.findGrant(ownerId, scope, tx);
      if ((current?.version ?? 0) !== input.expectedVersion)
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      if (current?.enabled === input.enabled) return grantView(current);
      if (input.expectedVersion === 2_147_483_647)
        throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
      const updated = {
        ownerId,
        terminalId: terminal.id,
        id: current?.id ?? randomUUID(),
        conversationId: input.conversationId.toLowerCase(),
        companionId: input.companionId.toLowerCase(),
        runtimeEpoch: input.runtimeEpoch,
        workspaceId: input.workspaceId,
        tool: input.tool,
        enabled: input.enabled,
        version: input.expectedVersion + 1,
      };
      if (current)
        await tx
          .update(terminalGrants)
          .set({ enabled: input.enabled, version: updated.version })
          .where(and(eq(terminalGrants.ownerId, ownerId), eq(terminalGrants.id, current.id)));
      else await tx.insert(terminalGrants).values(updated);
      if (!input.enabled && current?.enabled)
        await this.journal.append(ownerId, {
          kind: 'disable_terminal_grant',
          grantId: current.id,
          terminalId: terminal.id,
          version: updated.version,
        });
      return grantView(updated);
    });
  }

  /** 授权清单可回查版本，便于手动撤销或处理并发修改。 */
  listGrants(
    ownerId: string,
    id: string,
    query: IdPaginationQuery,
  ): Promise<{ items: TerminalGrant[]; nextAfterId: string | null }> {
    return this.store.locked(ownerId, async (tx) => {
      await this.terminal(ownerId, id, tx);
      const rows = await tx
        .select()
        .from(terminalGrants)
        .where(
          and(
            eq(terminalGrants.ownerId, ownerId),
            eq(terminalGrants.terminalId, id),
            query.afterId ? gt(terminalGrants.id, query.afterId) : undefined,
          ),
        )
        .orderBy(asc(terminalGrants.id))
        .limit(query.limit + 1);
      return {
        items: rows.slice(0, query.limit).map(grantView),
        nextAfterId: rows.length > query.limit ? rows[query.limit - 1]!.id : null,
      };
    });
  }

  /** 由明确用户命令安排动作，终端是否当前在线不改变命令身份。 */
  request(ownerId: string, input: RequestTerminalAction): Promise<TerminalAction> {
    return this.store.locked(ownerId, (tx, now) => this.enqueue(ownerId, input, 'user', tx, now));
  }

  /**
   * 同一事务内登记动作。内部调用必须先校验消费者的任务租约与动作策略。
   * 伴侣提出请求也只使用已存在且作用域完全相同的授权。
   */
  async enqueue(
    ownerId: string,
    input: RequestTerminalAction,
    requestedBy: ActionOrigin,
    tx: DatabaseTransaction,
    now: Date,
  ): Promise<TerminalAction> {
    const key = input.requestId.toLowerCase();
    const terminal = await this.terminal(ownerId, input.terminalId, tx);
    const normalized = {
      ...input,
      requestId: key,
      terminalId: terminal.id,
      conversationId: input.conversationId.toLowerCase(),
      companionId: input.companionId.toLowerCase(),
      ...(input.source
        ? { source: { ...input.source, messageId: input.source.messageId.toLowerCase() } }
        : {}),
    };
    const hash = fingerprint(normalized);
    const [replay] = await tx
      .select()
      .from(terminalActions)
      .where(
        and(
          eq(terminalActions.ownerId, ownerId),
          eq(terminalActions.requestedBy, requestedBy),
          eq(terminalActions.requestId, key),
        ),
      )
      .limit(1);
    if (replay) {
      if (replay.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
      return this.visibleAction(ownerId, replay, terminal, tx, now);
    }
    const member = await this.requireScope(ownerId, normalized, tx);
    await this.requireSource(ownerId, normalized, normalized.source ?? null, member, tx);
    const grant = await this.findGrant(ownerId, normalized, tx);
    if (!grant?.enabled || grant.workspaceId !== normalized.workspaceId || terminal.revokedAt)
      throw new ApiException(API_CODES.ACCESS_DENIED);
    const pending = await tx
      .select({ id: terminalActions.id })
      .from(terminalActions)
      .where(
        and(
          eq(terminalActions.ownerId, ownerId),
          eq(terminalActions.terminalId, terminal.id),
          eq(terminalActions.state, 'queued'),
          gt(terminalActions.deadlineAt, now),
        ),
      )
      .limit(100);
    if (pending.length === 100)
      throw new ApiException(API_CODES.RATE_LIMITED, '该终端待执行动作过多。');
    const id = randomUUID();
    await tx.insert(terminalActions).values({
      id,
      ownerId,
      terminalId: terminal.id,
      requestId: key,
      fingerprint: hash,
      grantId: grant.id,
      grantVersion: grant.version,
      conversationId: normalized.conversationId,
      companionId: normalized.companionId,
      runtimeEpoch: normalized.runtimeEpoch,
      workspaceId: normalized.workspaceId,
      tool: normalized.tool,
      sourceMessageId: normalized.source?.messageId,
      sourceContentVersion: normalized.source?.contentVersion,
      requestedBy,
      arguments: normalized.arguments,
      state: 'queued',
      createdAt: now,
      deadlineAt: new Date(now.getTime() + this.limits.actionTimeoutMs),
    });
    return actionView(await this.action(ownerId, id, tx), 'queued');
  }

  /** 查询动作的实际状态，不给轮询者暴露设备凭据或领取令牌。 */
  getAction(ownerId: string, id: string): Promise<TerminalAction> {
    return this.store.locked(ownerId, async (tx, now) => {
      const action = await this.action(ownerId, id, tx);
      const terminal = await this.terminal(ownerId, action.terminalId, tx);
      return this.visibleAction(ownerId, action, terminal, tx, now);
    });
  }

  /** 在活动事务中核对同一作用域的终端结果。 */
  async activityDependency(
    ownerId: string,
    id: string,
    scope: Scope,
    tx: DatabaseTransaction,
    now: Date,
  ): Promise<TerminalAction> {
    const row = await this.action(ownerId, id, tx);
    if (
      row.companionId !== scope.companionId ||
      row.runtimeEpoch !== scope.runtimeEpoch ||
      row.conversationId !== scope.conversationId
    )
      throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    const terminal = await this.terminal(ownerId, row.terminalId, tx);
    return this.visibleAction(ownerId, row, terminal, tx, now);
  }

  /** 用户可以撤销未发出的请求。已发出的动作仍需核对结果。 */
  cancelAction(ownerId: string, id: string): Promise<TerminalAction> {
    return this.store.locked(ownerId, async (tx, now) => {
      const action = await this.action(ownerId, id, tx);
      const terminal = await this.terminal(ownerId, action.terminalId, tx);
      const view = await this.visibleAction(ownerId, action, terminal, tx, now);
      if (view.state === 'cancelled') return view;
      if (view.state !== 'queued') throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
      await this.updateAction(action, { state: 'cancelled', arguments: null }, tx);
      return actionView(action, 'cancelled');
    });
  }

  /** 领取时原子登记派发，丢失响应或重连不会自动产生第二次执行。 */
  claim(
    id: string,
    authorization: string | undefined,
    connectionId: string,
  ): Promise<TerminalDispatch | null> {
    return this.withDevice(id, authorization, async (terminal, tx, now) => {
      this.requireConnection(terminal, connectionId, now);
      const rows = await tx
        .select()
        .from(terminalActions)
        .where(
          and(
            eq(terminalActions.ownerId, terminal.ownerId),
            eq(terminalActions.terminalId, terminal.id),
            eq(terminalActions.state, 'queued'),
            eq(terminalActions.workspaceId, terminal.workspaceId!),
            gt(terminalActions.deadlineAt, now),
          ),
        )
        .orderBy(asc(terminalActions.createdAt), asc(terminalActions.id))
        .limit(CLAIM_SCAN);
      for (const action of rows) {
        if (
          action.workspaceId !== terminal.workspaceId ||
          !terminal.capabilities?.includes(action.tool)
        )
          continue;
        if (!(await this.actionAllowed(action, tx))) {
          await this.updateAction(action, { state: 'invalidated', arguments: null }, tx);
          continue;
        }
        if (!action.arguments) throw new ApiException(API_CODES.DATA_UNAVAILABLE);
        const fresh = await taskDatabaseTime(this.database, terminal.ownerId, tx);
        this.requireConnection(terminal, connectionId, fresh);
        if (action.deadlineAt <= fresh) continue;
        const claimId = randomUUID();
        await this.updateAction(
          action,
          { claimId, state: 'dispatched', dispatchedConnectionId: terminal.connectionId },
          tx,
        );
        return {
          id: action.id,
          workspaceId: action.workspaceId,
          tool: action.tool,
          claimId,
          arguments: action.arguments,
          deadlineAt: action.deadlineAt.toISOString(),
        };
      }
      return null;
    });
  }

  /** 当前设备可用原领取令牌核对旧派发，重复回执只接受同一结果。 */
  receipt(
    id: string,
    actionId: string,
    authorization: string | undefined,
    input: TerminalReceipt,
  ): Promise<TerminalAction> {
    return this.withDevice(id, authorization, async (terminal, tx, now) => {
      this.requireConnection(terminal, input.connectionId, now);
      const action = await this.action(terminal.ownerId, actionId, tx);
      if (action.terminalId !== terminal.id || action.claimId !== input.claimId.toLowerCase())
        throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      if (!(await this.actionAllowed(action, tx))) throw new ApiException(API_CODES.ACCESS_DENIED);
      const hash = fingerprint(input.outcome);
      if (action.receiptHash) {
        if (action.receiptHash !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return actionView(action, action.state);
      }
      if (action.state !== 'dispatched' && action.state !== 'unknown')
        throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
      const result = input.outcome.state === 'succeeded' ? input.outcome.result : null;
      if (result && action.arguments?.text !== result.text)
        throw new ApiException(API_CODES.INVALID_REQUEST, '诊断回执与派发参数不匹配。');
      const state = input.outcome.state;
      await this.updateAction(action, { state, receiptHash: hash, result, arguments: null }, tx);
      return actionView({ ...action, result }, state);
    });
  }

  /** 读取单个会话参与者的实时能力交集，供聊天与后续活动使用。 */
  async capabilities(
    ownerId: string,
    scope: Scope,
    tx: DatabaseTransaction,
  ): Promise<TerminalCapability[]> {
    const now = await taskDatabaseTime(this.database, ownerId, tx);
    const rows = await tx
      .select({ grant: terminalGrants, terminal: terminals })
      .from(terminalGrants)
      .innerJoin(
        terminals,
        and(eq(terminals.ownerId, ownerId), eq(terminals.id, terminalGrants.terminalId)),
      )
      .where(
        and(
          eq(terminalGrants.ownerId, ownerId),
          eq(terminalGrants.conversationId, scope.conversationId),
          eq(terminalGrants.companionId, scope.companionId),
          eq(terminalGrants.runtimeEpoch, scope.runtimeEpoch),
          eq(terminalGrants.enabled, true),
          eq(terminals.workspaceId, terminalGrants.workspaceId),
          sql`JSON_CONTAINS(${terminals.capabilities}, JSON_QUOTE(${terminalGrants.tool}))`,
          isNull(terminals.revokedAt),
          gt(terminals.expiresAt, now),
        ),
      )
      .orderBy(asc(terminalGrants.id))
      .limit(MAX_TERMINALS);
    return rows.flatMap(({ grant, terminal }) =>
      grant.workspaceId === terminal.workspaceId && terminal.capabilities?.includes(grant.tool)
        ? [{ terminalId: terminal.id, workspaceId: grant.workspaceId, tool: grant.tool }]
        : [],
    );
  }

  private async withDevice<T>(
    id: string,
    authorization: string | undefined,
    command: (row: TerminalRow, tx: DatabaseTransaction, now: Date) => Promise<T>,
  ): Promise<T> {
    const secret = /^Bearer ([a-f0-9]{64})$/u.exec(authorization ?? '')?.[1];
    if (!secret) throw new ApiException(API_CODES.AUTH_REQUIRED);
    const hash = Buffer.from(hashSecret(secret), 'hex');
    const [candidate] = await this.database.sql
      .select()
      .from(terminals)
      .where(eq(terminals.id, id))
      .limit(1);
    if (
      !candidate ||
      candidate.revokedAt ||
      !timingSafeEqual(hash, Buffer.from(candidate.secretHash, 'hex'))
    )
      throw new ApiException(API_CODES.AUTH_REQUIRED);
    return this.store.locked(candidate.ownerId, async (tx, now) => {
      const current = await this.terminal(candidate.ownerId, id, tx);
      if (current.revokedAt || current.secretHash !== candidate.secretHash)
        throw new ApiException(API_CODES.AUTH_REQUIRED);
      return command(current, tx, now);
    });
  }

  private requireConnection(row: TerminalRow, connectionId: string, now: Date): void {
    if (row.connectionId !== connectionId.toLowerCase() || !isOnline(row, now))
      throw new ApiException(API_CODES.VERSION_CONFLICT, '终端连接已失效，请重新连接。');
  }

  private async terminal(ownerId: string, id: string, db: QueryDatabase): Promise<TerminalRow> {
    const [row] = await db
      .select()
      .from(terminals)
      .where(and(eq(terminals.ownerId, ownerId), eq(terminals.id, id)))
      .limit(1);
    if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    return row;
  }

  private async action(ownerId: string, id: string, db: QueryDatabase): Promise<ActionRow> {
    const [row] = await db
      .select()
      .from(terminalActions)
      .where(and(eq(terminalActions.ownerId, ownerId), eq(terminalActions.id, id)))
      .limit(1);
    if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    return row;
  }

  private async findGrant(
    ownerId: string,
    scope: Pick<
      GrantRow,
      'terminalId' | 'conversationId' | 'companionId' | 'runtimeEpoch' | 'workspaceId' | 'tool'
    >,
    db: QueryDatabase,
  ): Promise<GrantRow | undefined> {
    const [row] = await db
      .select()
      .from(terminalGrants)
      .where(
        and(
          eq(terminalGrants.ownerId, ownerId),
          eq(terminalGrants.terminalId, scope.terminalId),
          eq(terminalGrants.conversationId, scope.conversationId),
          eq(terminalGrants.companionId, scope.companionId),
          eq(terminalGrants.runtimeEpoch, scope.runtimeEpoch),
          eq(terminalGrants.workspaceId, scope.workspaceId),
          eq(terminalGrants.tool, scope.tool),
        ),
      )
      .limit(1);
    return row;
  }

  private async requireScope(ownerId: string, scope: Scope, tx: DatabaseTransaction) {
    const member = await requireCompanionMember(
      this.database,
      ownerId,
      scope.companionId,
      scope.runtimeEpoch,
      scope.conversationId,
      tx,
    );
    if (member.deletedAt || member.leftSequence !== null)
      throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    return member;
  }

  private async requireSource(
    ownerId: string,
    scope: Scope,
    source: TerminalAction['source'],
    member: Awaited<ReturnType<TerminalService['requireScope']>>,
    tx: DatabaseTransaction,
  ): Promise<void> {
    if (!source) return;
    const [row] = await tx
      .select({ sequence: messages.sequence })
      .from(messages)
      .where(
        and(
          eq(messages.ownerId, ownerId),
          eq(messages.conversationId, scope.conversationId),
          eq(messages.id, source.messageId),
          eq(messages.contentVersion, source.contentVersion),
          eq(messages.state, 'published'),
          isNull(messages.deletedAt),
        ),
      )
      .limit(1);
    if (row?.sequence == null) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    await assertVisible(member, row.sequence, tx);
  }

  private async actionAllowed(action: ActionRow, tx: DatabaseTransaction): Promise<boolean> {
    try {
      const member = await this.requireScope(action.ownerId, action, tx);
      await this.requireSource(action.ownerId, action, actionSource(action), member, tx);
      const current = await this.findGrant(action.ownerId, action, tx);
      return (
        current?.id === action.grantId && current.enabled && current.version === action.grantVersion
      );
    } catch (error) {
      if (error instanceof ApiException) return false;
      throw error;
    }
  }

  private async visibleAction(
    ownerId: string,
    action: ActionRow,
    terminal: TerminalRow,
    tx: DatabaseTransaction,
    now: Date,
  ): Promise<TerminalAction> {
    const member = await this.requireScope(ownerId, action, tx);
    await this.requireSource(ownerId, action, actionSource(action), member, tx);
    if (action.state === 'queued') {
      const terminalInvalid = terminal.revokedAt || !(await this.actionAllowed(action, tx));
      const state = terminalInvalid
        ? 'invalidated'
        : action.deadlineAt <= now
          ? 'not-executed'
          : 'queued';
      if (state !== 'queued') await this.updateAction(action, { state, arguments: null }, tx);
      return actionView(action, state);
    }
    if (
      action.state === 'dispatched' &&
      (!isOnline(terminal, now) ||
        action.dispatchedConnectionId !== terminal.connectionId ||
        action.deadlineAt <= now ||
        !(await this.actionAllowed(action, tx)))
    ) {
      await this.updateAction(action, { state: 'unknown' }, tx);
      return actionView(action, 'unknown');
    }
    return actionView(action, action.state);
  }

  /** 保留所有已经派发的领取身份，仅改变其可观察结果状态。 */
  private async markUnknown(row: TerminalRow, tx: DatabaseTransaction): Promise<void> {
    await tx
      .update(terminalActions)
      .set({ state: 'unknown' })
      .where(
        and(
          eq(terminalActions.ownerId, row.ownerId),
          eq(terminalActions.terminalId, row.id),
          eq(terminalActions.state, 'dispatched'),
        ),
      );
  }

  private async updateAction(
    row: ActionRow,
    values: Partial<typeof terminalActions.$inferInsert>,
    tx: DatabaseTransaction,
  ): Promise<void> {
    await tx
      .update(terminalActions)
      .set(values)
      .where(and(eq(terminalActions.ownerId, row.ownerId), eq(terminalActions.id, row.id)));
  }
}

/** 摘要不进入响应，设备凭据由登记方生成并保管。 */
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'ascii').digest('hex');
}

function isOnline(row: TerminalRow, now: Date): boolean {
  return (
    !row.revokedAt && row.connectionId !== null && row.expiresAt !== null && row.expiresAt > now
  );
}

function terminalView(row: TerminalRow, now: Date): Terminal {
  const online = isOnline(row, now);
  return {
    id: row.id,
    name: row.name,
    state: row.revokedAt ? 'revoked' : online ? 'online' : 'offline',
    lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
    workspaceId: online ? row.workspaceId : null,
    capabilities: online ? (row.capabilities ?? []) : [],
  };
}

function grantView({ ownerId: _ownerId, ...grant }: GrantRow): TerminalGrant {
  return grant;
}

function actionSource(row: ActionRow): TerminalAction['source'] {
  return row.sourceMessageId && row.sourceContentVersion
    ? { messageId: row.sourceMessageId, contentVersion: row.sourceContentVersion }
    : null;
}

function actionView(row: ActionRow, state: TerminalAction['state']): TerminalAction {
  return {
    id: row.id,
    terminalId: row.terminalId,
    conversationId: row.conversationId,
    companionId: row.companionId,
    runtimeEpoch: row.runtimeEpoch,
    workspaceId: row.workspaceId,
    tool: row.tool,
    requestedBy: row.requestedBy,
    origin: row.requestedBy === 'user' ? 'web' : 'backend',
    source: actionSource(row),
    state,
    result: row.result,
    createdAt: row.createdAt.toISOString(),
    deadlineAt: row.deadlineAt.toISOString(),
  };
}
