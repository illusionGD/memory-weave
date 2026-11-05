import { DatabaseService } from '../../database/database.service';
import type { IdPaginationQuery, TaskOutboxList } from '@memory-weave/contracts';
import { API_CODES } from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { idCursorPage } from '../../database/cursor-pagination';
import type { DatabaseTransaction } from '../../database/database.service';
import { messages, taskOutbox } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { fingerprint } from '../shared/http';
import { TaskConfigurationService } from './task-configuration.service';
import { TaskStore } from './task-store';
import type { MessageOutboxInput } from './task-types';

/**
 * 登记消息发布对应的待办事件。
 *
 * 在调用方业务事务内登记，重复事件不能替换已经保存的接收范围。
 */
export async function stageMessageOutbox(
  database: DatabaseService,
  ownerId: string,
  tx: DatabaseTransaction,
  payload: MessageOutboxInput,
): Promise<void> {
  const eventKey = `message:${payload.messageId.toLowerCase()}:${payload.contentVersion}`;
  const existing = await database.taskOutbox.findOne(ownerId, { where: { eventKey } }, tx);
  if (existing) {
    if (fingerprint(existing.payload) !== fingerprint(payload))
      throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
    return;
  }
  await database.taskOutbox.insert(
    ownerId,
    {
      eventKey,
      kind: 'message_published',
      sourceId: payload.messageId,
      sourceVersion: payload.contentVersion,
      payload,
    },
    tx,
  );
}

/** 只在主库内转交任务；不在转交事务中访问模型、向量库或工具。 */
@Injectable()
export class TaskOutboxService {
  /** 初始化待办事件转交服务。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(TaskConfigurationService) private readonly configuration: TaskConfigurationService,
  ) {}

  /**
   * 分页查询待办事件及其转交状态。
   *
   * 分页展示待办与转交状态，不代表相应伴侣完成记忆整理。
   */
  list(ownerId: string, query: IdPaginationQuery): Promise<TaskOutboxList> {
    return this.store.locked(ownerId, async (tx) => {
      const rows = await this.database.taskOutbox.findMany(
        ownerId,
        {
          where: query.afterId ? gt(taskOutbox.id, query.afterId) : undefined,
          orderBy: [asc(taskOutbox.id)],
          limit: query.limit + 1,
        },
        tx,
      );
      const page = idCursorPage(rows, query.limit, (row) => row.id);
      return {
        items: page.items.map((row) => ({
          id: row.id,
          kind: row.kind,
          status: row.status,
          sourceId: row.sourceId,
          sourceVersion: row.sourceVersion,
          reason: row.reason,
          createdAt: row.createdAt.toISOString(),
          dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
        })),
        nextAfterId: page.nextAfterId,
      };
    });
  }

  /**
   * 批量转交待办事件并保存处理结果。
   *
   * 有界转交且幂等，任一存储写入失败则整批回滚，下一轮仍能重新领取。
   */
  dispatch(ownerId: string): Promise<number> {
    return this.store.locked(ownerId, async (tx, now) => {
      const current = await this.configuration.current(ownerId, tx);
      if (!current.config.enabled) return 0;
      const rows = await this.database.taskOutbox.findMany(
        ownerId,
        {
          where: { status: 'pending' },
          orderBy: [asc(taskOutbox.createdAt), asc(taskOutbox.id)],
          limit: current.config.outboxBatchSize,
        },
        tx,
      );
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
              isNull(messages.deletedAt),
              eq(messages.sequence, payload.sequence),
            ),
          )
          .for('update');
        if (!source) {
          await this.database.taskOutbox.update(
            ownerId,
            event.id,
            { status: 'blocked', reason: 'source_changed' },
            tx,
          );
          continue;
        }
        // F08 以已持久登记的 processingRanges 组成批次，不再为每条消息创建占位任务。
        await this.database.taskOutbox.update(
          ownerId,
          event.id,
          { status: 'dispatched', reason: null, dispatchedAt: now },
          tx,
        );
      }
      return rows.length;
    });
  }
}
