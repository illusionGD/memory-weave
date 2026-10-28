import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { IdPaginationQuery, TaskOutboxList } from '@memory-weave/contracts';
import { API_CODES } from '@memory-weave/contracts';
import type { DatabaseTransaction } from '../../database/database.service';
import { messages, tasks, taskOutbox } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { fingerprint } from '../shared/http';
import { TaskStore } from './task-store';
import { TaskConfigurationService } from './task-configuration.service';
import { assertVisible, requireCompanionMember } from '../conversations/conversation-access';
import type { MessageOutboxInput } from './task-types';

/** 在调用方业务事务内登记，重复事件不能替换已经保存的接收范围。 */
export async function stageMessageOutbox(
  ownerId: string,
  tx: DatabaseTransaction,
  payload: MessageOutboxInput,
): Promise<void> {
  const eventKey = `message:${payload.messageId.toLowerCase()}:${payload.contentVersion}`;
  const [existing] = await tx
    .select()
    .from(taskOutbox)
    .where(and(eq(taskOutbox.ownerId, ownerId), eq(taskOutbox.eventKey, eventKey)));
  if (existing) {
    if (fingerprint(existing.payload) !== fingerprint(payload))
      throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
    return;
  }
  await tx.insert(taskOutbox).values({
    ownerId,
    eventKey,
    kind: 'message_published',
    sourceId: payload.messageId,
    sourceVersion: payload.contentVersion,
    payload,
  });
}

/** 只在主库内转交任务；不在转交事务中访问模型、向量库或工具。 */
@Injectable()
export class TaskOutboxService {
  constructor(
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(TaskConfigurationService) private readonly configuration: TaskConfigurationService,
  ) {}

  /** 分页展示待办与转交状态，不代表相应伴侣完成记忆整理。 */
  list(query: IdPaginationQuery): Promise<TaskOutboxList> {
    return this.store.locked(async (ownerId, tx) => {
      const rows = await tx
        .select()
        .from(taskOutbox)
        .where(
          and(
            eq(taskOutbox.ownerId, ownerId),
            query.afterId ? gt(taskOutbox.id, query.afterId) : undefined,
          ),
        )
        .orderBy(asc(taskOutbox.id))
        .limit(query.limit + 1);
      return {
        items: rows.slice(0, query.limit).map((row) => ({
          id: row.id,
          kind: row.kind,
          status: row.status,
          sourceId: row.sourceId,
          sourceVersion: row.sourceVersion,
          reason: row.reason,
          createdAt: row.createdAt.toISOString(),
          dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
        })),
        nextAfterId: rows.length > query.limit ? rows[query.limit - 1]!.id : null,
      };
    });
  }

  /** 有界转交且幂等，任一存储写入失败则整批回滚，下一轮仍能重新领取。 */
  dispatch(): Promise<number> {
    return this.store.locked(async (ownerId, tx, now) => {
      const current = await this.configuration.current(ownerId, tx);
      if (!current.config.enabled) return 0;
      const rows = await tx
        .select()
        .from(taskOutbox)
        .where(and(eq(taskOutbox.ownerId, ownerId), eq(taskOutbox.status, 'pending')))
        .orderBy(asc(taskOutbox.createdAt), asc(taskOutbox.id))
        .limit(current.config.outboxBatchSize);
      for (const event of rows) {
        const payload = event.payload;
        const [source] = await tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.ownerId, ownerId),
              eq(messages.id, payload.messageId),
              eq(messages.conversationId, payload.conversationId),
              eq(messages.contentVersion, payload.contentVersion),
              eq(messages.state, 'published'),
              eq(messages.sequence, payload.sequence),
            ),
          )
          .for('update');
        if (!source) {
          await tx
            .update(taskOutbox)
            .set({ status: 'blocked', reason: 'source_changed' })
            .where(eq(taskOutbox.id, event.id));
          continue;
        }
        for (const recipient of payload.recipients) {
          let reason = 'handler_unavailable';
          try {
            const member = await requireCompanionMember(
              ownerId,
              recipient.companionId,
              recipient.runtimeEpoch,
              payload.conversationId,
              tx,
            );
            if (member.permissionVersion !== recipient.permissionVersion)
              throw new ApiException(API_CODES.PERMISSION_VERSION_CONFLICT);
            await assertVisible(member, payload.sequence, tx);
          } catch (error) {
            if (
              !(error instanceof ApiException) ||
              ![
                API_CODES.RESOURCE_NOT_FOUND,
                API_CODES.RUNTIME_EPOCH_MISMATCH,
                API_CODES.PERMISSION_VERSION_CONFLICT,
              ].some((code) => code === error.code)
            )
              throw error;
            reason = 'scope_changed';
          }
          const requestKey = `memory:${recipient.companionId}:${recipient.runtimeEpoch}:${payload.messageId}:${payload.contentVersion}`;
          const [existing] = await tx
            .select({ id: tasks.id })
            .from(tasks)
            .where(and(eq(tasks.ownerId, ownerId), eq(tasks.requestKey, requestKey)));
          if (existing) continue;
          const input = {
            kind: 'memory_extraction' as const,
            messageId: payload.messageId,
            contentVersion: payload.contentVersion,
            sequence: payload.sequence,
            permissionVersion: recipient.permissionVersion,
          };
          const scope = {
            companionId: recipient.companionId,
            runtimeEpoch: recipient.runtimeEpoch,
            conversationId: payload.conversationId,
          };
          await tx.insert(tasks).values({
            id: randomUUID(),
            ownerId,
            requestKey,
            fingerprint: fingerprint({ input, scope }),
            kind: 'memory_extraction',
            input,
            scope,
            status: 'blocked',
            stage: 'awaiting_handler',
            reason,
            availableAt: now,
            createdAt: now,
            updatedAt: now,
          });
        }
        await tx
          .update(taskOutbox)
          .set({ status: 'dispatched', reason: null, dispatchedAt: now })
          .where(eq(taskOutbox.id, event.id));
      }
      return rows.length;
    });
  }
}
