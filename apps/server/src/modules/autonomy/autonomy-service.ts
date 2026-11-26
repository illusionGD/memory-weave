import { Inject, Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import type {
  AutonomyOpportunities,
  AutonomyOpportunity,
  AutonomyPolicy,
  AutonomyQuery,
  ConfigureAutonomy,
} from '@memory-weave/contracts';
import { and, asc, eq, gt, inArray, isNull, notExists } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  autonomyOpportunities,
  autonomyPolicies,
  companions,
  conversations,
  tasks,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { requireCompanion, requireConversation } from '../conversations/conversation-access';
import { ModelConfigurationService } from '../models/model-configuration.service';
import { fingerprint } from '../shared/http';
import { TaskStore } from '../tasks/task-store';
import { AutonomyBudget } from './autonomy-budget';
import {
  autonomyScopeUnavailable,
  currentAutonomyPolicy,
  requireAutonomyScope,
} from './autonomy-policy';
import type { Policy } from './autonomy-policy';

/** 自主工作需要当前授权，机会身份与每日额度保存在主库。 */
@Injectable()
export class AutonomyService {
  private nextScanAt = 0;
  private scanAfter: string | null = null;

  /** 初始化自主配置和有界调度。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(AutonomyBudget) private readonly budget: AutonomyBudget,
    @Inject(ModelConfigurationService) private readonly configuration: ModelConfigurationService,
  ) {}

  /** 查看当前实例生效的显式许可。 */
  settings(ownerId: string, id: string, runtimeEpoch: number): Promise<AutonomyPolicy | null> {
    return this.store.locked(ownerId, async (tx) => {
      await requireCompanion(this.database, ownerId, id, runtimeEpoch, tx);
      const current = await currentAutonomyPolicy(ownerId, id, runtimeEpoch, tx);
      return current ? policyView(current) : null;
    });
  }

  /** 逐次追加当前部署用户授权，无需逐项确认单个机会。 */
  configure(ownerId: string, id: string, command: ConfigureAutonomy): Promise<AutonomyPolicy> {
    const { runtimeEpoch, enabled, contactsEnabled } = command;
    const requestId = command.requestId.toLowerCase();
    const conversationId = command.conversationId.toLowerCase();
    const hash = fingerprint({ ...command, requestId, conversationId });
    return this.store.locked(ownerId, async (tx, now) => {
      await requireCompanion(this.database, ownerId, id, runtimeEpoch, tx);
      await requireConversation(ownerId, conversationId, tx);
      const [replay] = await tx
        .select()
        .from(autonomyPolicies)
        .where(
          and(
            eq(autonomyPolicies.ownerId, ownerId),
            eq(autonomyPolicies.companionId, id),
            eq(autonomyPolicies.requestId, requestId),
          ),
        )
        .limit(1);
      if (replay) {
        if (replay.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return policyView(replay);
      }
      if (enabled)
        await requireAutonomyScope(
          this.database,
          { ownerId, companionId: id, runtimeEpoch, conversationId },
          tx,
        );
      const current = await currentAutonomyPolicy(ownerId, id, runtimeEpoch, tx);
      const expected = current?.version ?? 0;
      if (expected !== command.expectedVersion) throw new ApiException(API_CODES.VERSION_CONFLICT);
      if (expected >= 2_147_483_647) throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
      const version = expected + 1;
      await tx.insert(autonomyPolicies).values({
        ownerId,
        companionId: id,
        runtimeEpoch,
        conversationId,
        version,
        enabled,
        contactsEnabled,
        requestId,
        fingerprint: hash,
        createdAt: now,
      });
      return { conversationId, runtimeEpoch, version, enabled, contactsEnabled };
    });
  }

  /** 查询实际机会与是否成为活动、联系或保持安静。 */
  opportunities(ownerId: string, id: string, query: AutonomyQuery): Promise<AutonomyOpportunities> {
    return this.store.locked(ownerId, async (tx) => {
      await requireCompanion(this.database, ownerId, id, query.runtimeEpoch, tx);
      const rows = await tx
        .select({
          opportunity: autonomyOpportunities,
          taskReason: tasks.reason,
          restricted: conversations.lifecycleOperationId,
        })
        .from(autonomyOpportunities)
        .innerJoin(tasks, and(eq(tasks.ownerId, ownerId), eq(tasks.id, autonomyOpportunities.id)))
        .innerJoin(
          conversations,
          and(
            eq(conversations.ownerId, ownerId),
            eq(conversations.id, autonomyOpportunities.conversationId),
          ),
        )
        .where(
          and(
            eq(autonomyOpportunities.ownerId, ownerId),
            eq(autonomyOpportunities.companionId, id),
            eq(autonomyOpportunities.runtimeEpoch, query.runtimeEpoch),
            query.afterId ? gt(autonomyOpportunities.id, query.afterId) : undefined,
          ),
        )
        .orderBy(asc(autonomyOpportunities.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const items: AutonomyOpportunity[] = page.map(
        ({ opportunity: row, taskReason, restricted }) => ({
          id: row.id,
          conversationId: row.conversationId,
          runtimeEpoch: row.runtimeEpoch,
          outcome: row.outcome,
          reason: row.reason ?? taskReason,
          explanation: restricted ? null : row.explanation,
          mode: row.mode,
          activityId: row.activityId,
          contactId: row.contactId,
          invitationId: row.invitationId,
          createdAt: row.createdAt.toISOString(),
        }),
      );
      return { items, nextAfterId: rows.length > query.limit ? page.at(-1)!.opportunity.id : null };
    });
  }

  /** 定期选取有限数量的已许可机会，空闲检查本身不消耗模型。 */
  async wake(ownerId: string): Promise<void> {
    if (!this.budget.limits.enabled || Date.now() < this.nextScanAt) return;
    this.nextScanAt = Date.now() + 1000;
    const config = await this.configuration.get(ownerId);
    const role = config.config.tasks.reflection;
    if (!role.enabled) return;
    await this.store.locked(ownerId, async (tx, now) => {
      const newer = alias(autonomyPolicies, 'newer_autonomy_policy');
      const rows = await tx
        .select({ policy: autonomyPolicies })
        .from(autonomyPolicies)
        .innerJoin(
          companions,
          and(
            eq(companions.ownerId, ownerId),
            eq(companions.id, autonomyPolicies.companionId),
            eq(companions.runtimeEpoch, autonomyPolicies.runtimeEpoch),
            isNull(companions.deletedAt),
          ),
        )
        .where(
          and(
            eq(autonomyPolicies.ownerId, ownerId),
            eq(autonomyPolicies.enabled, true),
            this.scanAfter ? gt(autonomyPolicies.companionId, this.scanAfter) : undefined,
            notExists(
              tx
                .select({ version: newer.version })
                .from(newer)
                .where(
                  and(
                    eq(newer.ownerId, ownerId),
                    eq(newer.companionId, autonomyPolicies.companionId),
                    eq(newer.runtimeEpoch, autonomyPolicies.runtimeEpoch),
                    gt(newer.version, autonomyPolicies.version),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(autonomyPolicies.companionId))
        .limit(12);
      this.scanAfter = rows.length === 12 ? rows.at(-1)!.policy.companionId : null;
      for (const { policy } of rows) {
        try {
          await this.schedule(
            policy,
            config.version,
            role.providerId === 'test' ? 'test' : 'model',
            tx,
            now,
          );
        } catch (error) {
          if (!autonomyScopeUnavailable(error)) throw error;
        }
      }
    });
  }

  /** 用精确会话、授权版本和机会额度登记首次生成。 */
  private async schedule(
    policy: Policy,
    configVersion: number,
    mode: 'test' | 'model',
    tx: DatabaseTransaction,
    now: Date,
  ): Promise<void> {
    const { ownerId, companionId, runtimeEpoch, conversationId } = policy;
    const recent = await this.budget.lastOpportunity(ownerId, companionId, tx);
    if (recent && now.getTime() - recent.getTime() < this.budget.limits.explorationIntervalMs)
      return;
    if (
      (await this.budget.count(ownerId, 'exploration', companionId, now, tx)) >=
        this.budget.limits.explorationsPerDay ||
      (await this.budget.count(ownerId, 'model', companionId, now, tx)) >=
        this.budget.limits.modelCallsPerDay
    )
      return;
    const [active] = await tx
      .select({ id: autonomyOpportunities.id })
      .from(autonomyOpportunities)
      .innerJoin(
        tasks,
        and(
          eq(tasks.ownerId, ownerId),
          eq(tasks.id, autonomyOpportunities.id),
          inArray(tasks.status, ['queued', 'running', 'waiting', 'paused']),
        ),
      )
      .where(
        and(
          eq(autonomyOpportunities.ownerId, ownerId),
          eq(autonomyOpportunities.companionId, companionId),
          eq(autonomyOpportunities.runtimeEpoch, runtimeEpoch),
        ),
      )
      .limit(1);
    if (active) return;
    await requireAutonomyScope(this.database, policy, tx);
    const id = randomUUID();
    await this.budget.record(ownerId, 'exploration', companionId, id, now, tx);
    await this.database.tasks.insert(
      ownerId,
      {
        id,
        kind: 'autonomy',
        input: { kind: 'autonomy', configVersion },
        requestKey: `autonomy:${id}`,
        fingerprint: fingerprint({ companionId, runtimeEpoch, version: policy.version }),
        scope: { companionId, runtimeEpoch, conversationId },
        totalSteps: 1,
        availableAt: now,
      },
      tx,
    );
    await tx.insert(autonomyOpportunities).values({
      id,
      ownerId,
      companionId,
      runtimeEpoch,
      conversationId,
      policyVersion: policy.version,
      mode,
      outcome: 'pending',
      createdAt: now,
    });
  }
}

/** 对外只显示生效的授权信息。 */
function policyView(row: Policy): AutonomyPolicy {
  const { conversationId, runtimeEpoch, version, enabled, contactsEnabled } = row;
  return { conversationId, runtimeEpoch, version, enabled, contactsEnabled };
}
