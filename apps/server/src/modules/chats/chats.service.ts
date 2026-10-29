import { API_CODES, chatConfigurationSchema } from '@memory-weave/contracts';
import type {
  Chat,
  ChatConfiguration,
  ChatDelivery,
  ChatMessage,
  StopChat,
  ChatList,
  ChatMessageList,
  ChatMessageQuery,
  ChatRun,
  CreateChat,
  IdPaginationQuery,
  SendChatMessage,
  SentChatMessage,
} from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, lt, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  chatDeliveries,
  chatRuns,
  chatThreads,
  chatSegments,
  conversations,
  companions,
  messages,
  tasks,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { ConversationsService } from '../conversations/conversations.service';
import {
  requireCompanion,
  requireConversation,
  toMessage,
} from '../conversations/conversation-access';
import { fingerprint } from '../shared/http';
import { SERVER_CONFIG } from '../../config';
import type { RuntimeConfig } from '../../config';
import { ModelRuntimeService } from '../models/model-runtime.service';
import { TaskStore } from '../tasks/task-store';
import { TasksService } from '../tasks/tasks.service';

/** 私聊命令串行化原文、回复任务和当前轮次，网络调用始终在事务外。 */
@Injectable()
export class ChatsService {
  constructor(
    @Inject(SERVER_CONFIG) private readonly configuration: RuntimeConfig,
    @Inject(ModelRuntimeService) private readonly models: ModelRuntimeService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(TasksService) private readonly jobs: TasksService,
    @Inject(ConversationsService) private readonly originals: ConversationsService,
  ) {}

  /** 原子创建用户与单个伴侣的私聊，重复命令继续使用原会话。 */
  create(input: CreateChat): Promise<Chat> {
    return this.store.locked(async (ownerId, tx) => {
      const { conversation } = await this.originals.createInTransaction(ownerId, tx, {
        requestId: input.requestId,
        kind: 'private',
        title: input.title,
        includeUser: true,
        companions: [{ companionId: input.companionId, runtimeEpoch: input.runtimeEpoch }],
      });
      await tx
        .insert(chatThreads)
        .values({
          ownerId,
          conversationId: conversation.id,
          companionId: input.companionId,
          runtimeEpoch: input.runtimeEpoch,
        })
        .onDuplicateKeyUpdate({ set: { conversationId: conversation.id } });
      return this.read(ownerId, conversation.id, tx);
    });
  }

  /** 查询不会触发模型调用，也不代表用户已收到消息。 */
  get(id: string): Promise<Chat> {
    return this.store.locked((ownerId, tx) => this.read(ownerId, id, tx));
  }

  /** 有界 UUID 分页，只包含已经启用聊天的用户私聊。 */
  list(input: IdPaginationQuery): Promise<ChatList> {
    return this.store.locked(async (ownerId, tx) => {
      const rows = await tx
        .select()
        .from(chatThreads)
        .where(
          and(
            eq(chatThreads.ownerId, ownerId),
            input.afterId ? gt(chatThreads.conversationId, input.afterId) : undefined,
          ),
        )
        .orderBy(asc(chatThreads.conversationId))
        .limit(input.limit + 1);
      return {
        items: await Promise.all(
          rows.slice(0, input.limit).map((row) => this.read(ownerId, row.conversationId, tx)),
        ),
        nextAfterId: rows.length > input.limit ? rows[input.limit - 1]!.conversationId : null,
      };
    });
  }

  /** 用户输入先保存并发布；同一事务建立回复任务，HTTP 不等待生成。 */
  async send(id: string, input: SendChatMessage): Promise<SentChatMessage> {
    let cancelledCallId: string | null = null;
    const result = await this.store.locked(async (ownerId, tx, now) => {
      const thread = await this.thread(ownerId, id, tx);
      const hash = fingerprint({ text: input.text });
      const [replay] = await tx
        .select()
        .from(chatRuns)
        .where(
          and(
            eq(chatRuns.ownerId, ownerId),
            eq(chatRuns.conversationId, id),
            eq(chatRuns.requestId, input.requestId),
          ),
        );
      if (replay) {
        if (replay.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        const [message] = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.ownerId, ownerId), eq(messages.id, replay.triggerMessageId)));
        return {
          message: await toMessage(message!, tx),
          run: await this.run(ownerId, replay.id, tx),
        };
      }
      const conversation = await requireConversation(ownerId, id, tx, true);
      const draft = await this.originals.saveInTransaction(ownerId, tx, id, {
        requestId: input.requestId,
        speaker: { kind: 'user' },
        expectedConversationVersion: conversation.version,
        text: input.text,
        epistemicKind: 'statement',
        reality: 'unspecified',
        sources: [],
      });
      const message = await this.originals.publishInTransaction(ownerId, tx, id, draft.id, {
        requestId: input.requestId,
        expectedRevision: draft.revision,
        expectedConversationVersion: conversation.version,
      });
      const settings = this.configuration.chatConfiguration ?? chatConfigurationSchema.parse({});
      let firstUserSequence = message.sequence!;
      let batchStartedAt = now;
      if (thread.currentRunId) {
        const previous = await this.jobs.getInTransaction(ownerId, thread.currentRunId, tx);
        const [oldRun] = await tx
          .select()
          .from(chatRuns)
          .where(and(eq(chatRuns.ownerId, ownerId), eq(chatRuns.id, thread.currentRunId)));
        if (!['succeeded', 'failed', 'cancelled', 'blocked'].includes(previous.status)) {
          firstUserSequence = oldRun!.firstUserSequence;
          if (!oldRun!.context) batchStartedAt = oldRun!.batchStartedAt;
          await tx
            .update(chatRuns)
            .set({ interruptedAt: now })
            .where(and(eq(chatRuns.ownerId, ownerId), eq(chatRuns.id, previous.id)));
          const stopped = await this.jobs.controlInTransaction(
            ownerId,
            tx,
            now,
            previous.id,
            'cancel',
          );
          cancelledCallId = stopped.modelCallId;
        }
      }
      const runId = randomUUID();
      await tx.insert(tasks).values({
        id: runId,
        ownerId,
        requestKey: `chat_reply:${runId}`,
        fingerprint: hash,
        availableAt: new Date(
          Math.min(
            now.getTime() + settings.mergeWindowMs,
            batchStartedAt.getTime() + settings.maxMergeWaitMs,
          ),
        ),
        kind: 'chat_reply',
        input: { kind: 'chat_reply', runId },
        scope: {
          companionId: thread.companionId,
          runtimeEpoch: thread.runtimeEpoch,
          conversationId: id,
        },
        totalSteps: 1,
      });
      await tx.insert(chatRuns).values({
        id: runId,
        ownerId,
        conversationId: id,
        triggerMessageId: message.id,
        firstUserSequence,
        batchStartedAt,
        configuration: settings,
        requestId: input.requestId,
        fingerprint: hash,
      });
      await tx
        .update(chatThreads)
        .set({ currentRunId: runId })
        .where(and(eq(chatThreads.ownerId, ownerId), eq(chatThreads.conversationId, id)));
      return { message, run: await this.run(ownerId, runId, tx) };
    });
    if (cancelledCallId) await this.models.cancel(cancelledCallId).catch(() => undefined);
    return result;
  }

  /** 最近一页原文按时间正序展示，向前分页不一次加载全部聊天。 */
  history(id: string, input: ChatMessageQuery): Promise<ChatMessageList> {
    return this.store.locked(async (ownerId, tx) => {
      await this.thread(ownerId, id, tx, false);
      await requireConversation(ownerId, id, tx);
      const rows = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.ownerId, ownerId),
            eq(messages.conversationId, id),
            eq(messages.state, 'published'),
            input.beforeSequence ? lt(messages.sequence, input.beforeSequence) : undefined,
          ),
        )
        .orderBy(desc(messages.sequence))
        .limit(input.limit + 1);
      return {
        items: await this.messageItems(ownerId, tx, rows.slice(0, input.limit).reverse()),
        nextBeforeSequence: rows.length > input.limit ? rows[input.limit - 1]!.sequence : null,
      };
    });
  }

  /** 普通配置可公开查看，不包含模型凭据；部署修改后新轮次才采用。 */
  settings(): ChatConfiguration {
    return this.configuration.chatConfiguration ?? chatConfigurationSchema.parse({});
  }

  /** 从确切发布序号之后读取事件，每次最多 50 条；不会推进送达状态。 */
  after(id: string, afterSequence: number): Promise<ChatMessage[]> {
    return this.store.locked(async (ownerId, tx) => {
      await this.thread(ownerId, id, tx, false);
      await requireConversation(ownerId, id, tx);
      const rows = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.ownerId, ownerId),
            eq(messages.conversationId, id),
            eq(messages.state, 'published'),
            gt(messages.sequence, afterSequence),
          ),
        )
        .orderBy(asc(messages.sequence))
        .limit(50);
      return this.messageItems(ownerId, tx, rows);
    });
  }

  /** 逐条核对本会话原文版本，所有回执同事务提交，重复确认不更新时间。 */
  acknowledge(id: string, input: ChatDelivery): Promise<null> {
    return this.store.locked(async (ownerId, tx) => {
      await this.thread(ownerId, id, tx, false);
      await requireConversation(ownerId, id, tx);
      const rows = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.ownerId, ownerId),
            eq(messages.conversationId, id),
            eq(messages.state, 'published'),
            inArray(
              messages.id,
              input.messages.map((item) => item.messageId),
            ),
          ),
        );
      if (
        rows.length !== input.messages.length ||
        rows.some(
          (row) =>
            !input.messages.some(
              (item) => item.messageId === row.id && item.contentVersion === row.contentVersion,
            ),
        )
      )
        throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      await tx
        .insert(chatDeliveries)
        .values(
          rows.map((row) => ({
            ownerId,
            messageId: row.id,
            contentVersion: row.contentVersion,
            terminalId: input.terminalId,
          })),
        )
        .onDuplicateKeyUpdate({ set: { id: sql`${chatDeliveries.id}` } });
      return null;
    });
  }

  /** 停止目标轮次并立即撤销租约；网络中止在事务提交之后尝试。 */
  async stop(id: string, input: StopChat): Promise<Chat> {
    const callId = await this.store.locked(async (ownerId, tx, now) => {
      const thread = await this.thread(ownerId, id, tx);
      const [run] = await tx
        .select()
        .from(chatRuns)
        .where(
          and(
            eq(chatRuns.ownerId, ownerId),
            eq(chatRuns.conversationId, id),
            eq(chatRuns.id, input.runId),
          ),
        );
      if (!run) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      if (run.interruptedAt) return null;
      if (thread.currentRunId !== run.id) throw new ApiException(API_CODES.VERSION_CONFLICT);
      const job = await this.jobs.getInTransaction(ownerId, run.id, tx);
      if (['succeeded', 'failed', 'cancelled', 'blocked'].includes(job.status)) return null;
      await tx
        .update(chatRuns)
        .set({ interruptedAt: now })
        .where(and(eq(chatRuns.ownerId, ownerId), eq(chatRuns.id, run.id)));
      return (await this.jobs.controlInTransaction(ownerId, tx, now, run.id, 'cancel')).modelCallId;
    });
    if (callId) await this.models.cancel(callId).catch(() => undefined);
    return this.get(id);
  }

  private async messageItems(
    ownerId: string,
    tx: DatabaseTransaction,
    rows: (typeof messages.$inferSelect)[],
  ): Promise<ChatMessage[]> {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const segments = await tx
      .select()
      .from(chatSegments)
      .where(and(eq(chatSegments.ownerId, ownerId), inArray(chatSegments.messageId, ids)));
    const deliveries = await tx
      .select({
        messageId: chatDeliveries.messageId,
        deliveredAt: sql<Date>`MIN(${chatDeliveries.deliveredAt})`.mapWith(
          chatDeliveries.deliveredAt,
        ),
      })
      .from(chatDeliveries)
      .where(and(eq(chatDeliveries.ownerId, ownerId), inArray(chatDeliveries.messageId, ids)))
      .groupBy(chatDeliveries.messageId);
    return Promise.all(
      rows.map(async (row) => ({
        message: await toMessage(row, tx),
        runId: segments.find((item) => item.messageId === row.id)?.runId ?? null,
        deliveredAt:
          deliveries.find((item) => item.messageId === row.id)?.deliveredAt.toISOString() ?? null,
      })),
    );
  }

  private async thread(
    ownerId: string,
    id: string,
    tx: DatabaseTransaction,
    active = true,
  ): Promise<typeof chatThreads.$inferSelect> {
    const [thread] = await tx
      .select()
      .from(chatThreads)
      .where(and(eq(chatThreads.ownerId, ownerId), eq(chatThreads.conversationId, id)));
    if (!thread) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    if (active) {
      await requireCompanion(ownerId, thread.companionId, thread.runtimeEpoch, tx);
      await requireConversation(ownerId, id, tx);
    }
    return thread;
  }

  private async read(ownerId: string, id: string, tx: DatabaseTransaction): Promise<Chat> {
    const thread = await this.thread(ownerId, id, tx, false);
    const [companion] = await tx
      .select()
      .from(companions)
      .where(and(eq(companions.ownerId, ownerId), eq(companions.id, thread.companionId)));
    const [conversation] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.ownerId, ownerId), eq(conversations.id, id)));
    const availability = conversation!.lifecycleOperationId
      ? 'cleaning'
      : !companion || companion.deletedAt || companion.runtimeEpoch !== thread.runtimeEpoch
        ? 'archived'
        : companion.lifecycleOperationId
          ? 'cleaning'
          : 'active';
    return {
      id,
      availability,
      contentRevision: conversation!.contentRevision + (companion?.version ?? 0),
      lifecycleOperationId:
        conversation!.lifecycleOperationId ?? companion?.lifecycleOperationId ?? null,
      title: conversation!.title,
      companionId: thread.companionId,
      runtimeEpoch: thread.runtimeEpoch,
      currentRun:
        availability === 'active' && thread.currentRunId
          ? await this.run(ownerId, thread.currentRunId, tx)
          : null,
      lastSequence: conversation!.lastSequence,
      createdAt: thread.createdAt.toISOString(),
    };
  }

  private async run(ownerId: string, id: string, tx: DatabaseTransaction): Promise<ChatRun> {
    const [row] = await tx
      .select()
      .from(chatRuns)
      .where(and(eq(chatRuns.ownerId, ownerId), eq(chatRuns.id, id)));
    if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    const task = await this.jobs.getInTransaction(ownerId, id, tx);
    return {
      id,
      conversationId: row.conversationId,
      triggerMessageId: row.triggerMessageId,
      status: row.interruptedAt ? 'interrupted' : task.status,
      task,
      context: row.context,
      mode: row.mode,
      transport: row.transport,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
