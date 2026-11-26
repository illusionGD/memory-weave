import { Inject, Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import type {
  AdministrationCalls,
  AdministrationCallsQuery,
  AdministrationLifecycle,
  AdministrationMessage,
  IdPaginationQuery,
} from '@memory-weave/contracts';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import {
  chatDeliveries,
  conversationMembers,
  lifecycleMessageTargets,
  modelAttempts,
  modelCalls,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import {
  assertVisible,
  requireCompanion,
  requireConversation,
} from '../conversations/conversation-access';
import { LifecycleService } from '../lifecycle/lifecycle.service';
import { ModelRuntimeService } from '../models/model-runtime.service';
import { TaskStore } from '../tasks/task-store';

/** 后台聚合实际运行记录。正文继续由原模块的权限入口提供。 */
@Injectable()
export class AdministrationObservations {
  /** 初始化实际发布、调用和生命周期查询。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(LifecycleService) private readonly lifecycle: LifecycleService,
    @Inject(ModelRuntimeService) private readonly models: ModelRuntimeService,
  ) {}

  /** 分页查看模型元数据和每次尝试的实际结算，不读输入输出正文。 */
  async calls(ownerId: string, query: AdministrationCallsQuery): Promise<AdministrationCalls> {
    if (query.companionId && query.runtimeEpoch)
      await requireCompanion(
        this.database,
        ownerId,
        query.companionId,
        query.runtimeEpoch,
        this.database.sql,
      );
    if (query.conversationId)
      await requireConversation(ownerId, query.conversationId, this.database.sql);
    await this.models.usage(ownerId);
    const rows = await this.database.sql
      .select({
        id: modelCalls.id,
        role: modelCalls.role,
        status: modelCalls.status,
        lane: modelCalls.lane,
        configVersion: modelCalls.configVersion,
        providerId: modelCalls.providerId,
        model: modelCalls.model,
        context: modelCalls.context,
        errorCode: modelCalls.errorCode,
        invalidatedAt: modelCalls.invalidatedAt,
        createdAt: modelCalls.createdAt,
        finishedAt: modelCalls.finishedAt,
      })
      .from(modelCalls)
      .where(
        and(
          eq(modelCalls.ownerId, ownerId),
          query.afterId ? gt(modelCalls.id, query.afterId) : undefined,
          query.role ? eq(modelCalls.role, query.role) : undefined,
          query.status ? eq(modelCalls.status, query.status) : undefined,
          query.companionId
            ? sql`JSON_UNQUOTE(JSON_EXTRACT(${modelCalls.context}, '$.companionId')) = ${query.companionId}`
            : undefined,
          query.runtimeEpoch
            ? sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${modelCalls.context}, '$.runtimeEpoch')) AS UNSIGNED) = ${query.runtimeEpoch}`
            : undefined,
          query.conversationId
            ? sql`JSON_UNQUOTE(JSON_EXTRACT(${modelCalls.context}, '$.conversationId')) = ${query.conversationId}`
            : undefined,
        ),
      )
      .orderBy(asc(modelCalls.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const attempts = page.length
      ? await this.database.sql
          .select({
            id: modelAttempts.callId,
            calls: sql<number>`count(*)`,
            tokens: sql<number>`sum(${modelAttempts.chargedTokens})`,
            cost: sql<number>`sum(${modelAttempts.chargedCostMicros})`,
          })
          .from(modelAttempts)
          .where(
            and(
              eq(modelAttempts.ownerId, ownerId),
              inArray(
                modelAttempts.callId,
                page.map((row) => row.id),
              ),
            ),
          )
          .groupBy(modelAttempts.callId)
      : [];
    const totals = new Map(attempts.map((row) => [row.id, row]));
    return {
      items: page.map(({ context, invalidatedAt, createdAt, finishedAt, ...row }) => ({
        ...row,
        companionId: context.companionId,
        conversationId: context.conversationId,
        runtimeEpoch: context.runtimeEpoch,
        invalidated: Boolean(invalidatedAt),
        attempts: Number(totals.get(row.id)?.calls ?? 0),
        tokens: Number(totals.get(row.id)?.tokens ?? 0),
        chargedCostMicros: Number(totals.get(row.id)?.cost ?? 0),
        createdAt: createdAt.toISOString(),
        elapsedMs: finishedAt ? Math.max(0, finishedAt.getTime() - createdAt.getTime()) : null,
      })),
      nextAfterId: rows.length > query.limit ? page.at(-1)!.id : null,
    };
  }

  /** 分开报告消息正式发布、当前可见、实际读取、整理和终端交付。 */
  async message(
    ownerId: string,
    conversationId: string,
    messageId: string,
    query: IdPaginationQuery,
  ): Promise<AdministrationMessage> {
    return this.store.locked(ownerId, async (tx) => {
      await requireConversation(ownerId, conversationId, tx);
      const message = await this.database.messages.findOne(
        ownerId,
        { where: { id: messageId, conversationId } },
        tx,
      );
      if (!message) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      const members = await this.database.conversationMembers.findMany(
        ownerId,
        {
          where: and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.kind, 'companion'),
          ),
          limit: 20,
        },
        tx,
      );
      const versions = { messageId, contentVersion: message.contentVersion };
      const [receipts, ranges, delivered] = await Promise.all([
        this.database.readReceipts.findMany(ownerId, { where: versions, limit: 20 }, tx),
        this.database.processingRanges.findMany(ownerId, { where: versions, limit: 20 }, tx),
        tx
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.ownerId, ownerId),
              eq(chatDeliveries.messageId, messageId),
              eq(chatDeliveries.contentVersion, message.contentVersion),
              query.afterId ? gt(chatDeliveries.id, query.afterId) : undefined,
            ),
          )
          .orderBy(asc(chatDeliveries.id))
          .limit(query.limit + 1),
      ]);
      const participants: AdministrationMessage['participants'] = [];
      for (const member of members) {
        const companionId = member.companionId!;
        const runtimeEpoch = member.runtimeEpoch!;
        let visible = false;
        if (message.sequence !== null && !message.deletedAt) {
          try {
            await requireCompanion(this.database, ownerId, companionId, runtimeEpoch, tx);
            await assertVisible(member, message.sequence, tx);
            visible = true;
          } catch (error) {
            if (!(error instanceof ApiException)) throw error;
          }
        }
        const read = receipts.find(
          (item) => item.companionId === companionId && item.runtimeEpoch === runtimeEpoch,
        );
        const processed = ranges.find(
          (item) => item.companionId === companionId && item.runtimeEpoch === runtimeEpoch,
        );
        participants.push({
          companionId,
          runtimeEpoch,
          permissionVersion: member.permissionVersion,
          visible,
          read: read
            ? {
                at: read.acquiredAt.toISOString(),
                startOffset: read.startOffset,
                endOffset: read.endOffset,
              }
            : null,
          processing: processed?.status ?? null,
        });
      }
      const page = delivered.slice(0, query.limit);
      return {
        conversationId,
        messageId,
        contentVersion: message.contentVersion,
        sourceKind: message.sourceKind,
        sequence: message.sequence,
        published: message.state === 'published',
        deleted: Boolean(message.deletedAt),
        participants,
        deliveries: page.map((item) => ({
          terminalId: item.terminalId,
          at: item.deliveredAt.toISOString(),
        })),
        deliveriesNextAfterId: delivered.length > query.limit ? page.at(-1)!.id : null,
      };
    });
  }

  /** 在原有生命周期进度旁提供确切选择和已发现传播目标。 */
  async deletion(
    ownerId: string,
    id: string,
    query: IdPaginationQuery,
  ): Promise<AdministrationLifecycle> {
    const operation = await this.lifecycle.get(ownerId, id);
    const [rows, counts] = await Promise.all([
      this.database.sql
        .select()
        .from(lifecycleMessageTargets)
        .where(
          and(
            eq(lifecycleMessageTargets.ownerId, ownerId),
            eq(lifecycleMessageTargets.operationId, id),
            query.afterId ? gt(lifecycleMessageTargets.id, query.afterId) : undefined,
          ),
        )
        .orderBy(asc(lifecycleMessageTargets.id))
        .limit(query.limit + 1),
      this.database.sql
        .select({ kind: lifecycleMessageTargets.kind, total: sql<number>`count(*)` })
        .from(lifecycleMessageTargets)
        .where(
          and(
            eq(lifecycleMessageTargets.ownerId, ownerId),
            eq(lifecycleMessageTargets.operationId, id),
          ),
        )
        .groupBy(lifecycleMessageTargets.kind),
    ]);
    const targets = rows
      .slice(0, query.limit)
      .map(({ id, messageId, contentVersion, kind }) => ({ id, messageId, contentVersion, kind }));
    return {
      operation,
      selected: Number(counts.find((row) => row.kind === 'selected')?.total ?? 0),
      derived: Number(counts.find((row) => row.kind === 'derived')?.total ?? 0),
      targets,
      nextAfterId: rows.length > query.limit ? targets.at(-1)!.id : null,
    };
  }
}
