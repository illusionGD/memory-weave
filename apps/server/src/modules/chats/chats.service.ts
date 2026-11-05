import { DatabaseService } from '../../database/database.service';
import type {
  Chat,
  ChatConfiguration,
  ChatDelivery,
  ChatList,
  ChatMessage,
  ChatMessageList,
  ChatMessageQuery,
  ChatRun,
  CreateChat,
  IdPaginationQuery,
  SendChatMessage,
  SentChatMessage,
  StopChat,
} from '@memory-weave/contracts';
import { API_CODES, chatConfigurationSchema } from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { RuntimeConfig } from '../../config';
import { SERVER_CONFIG } from '../../config';
import type { DatabaseTransaction } from '../../database/database.service';
import { chatDeliveries, chatThreads, messages } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { publicAvatar } from '../companions/avatar-files';
import {
  requireCompanion,
  requireConversation,
  toMessage,
} from '../conversations/conversation-access';
import { ConversationsService } from '../conversations/conversations.service';
import { ModelRuntimeService } from '../models/model-runtime.service';
import { fingerprint } from '../shared/http';
import { TaskStore } from '../tasks/task-store';
import { TasksService } from '../tasks/tasks.service';

/** 私聊命令串行化原文、回复任务和当前轮次，网络调用始终在事务外。 */
@Injectable()
export class ChatsService {
  /** 初始化聊天会话与回复管理服务。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SERVER_CONFIG) private readonly configuration: RuntimeConfig,
    @Inject(ModelRuntimeService) private readonly models: ModelRuntimeService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(TasksService) private readonly jobs: TasksService,
    @Inject(ConversationsService) private readonly originals: ConversationsService,
  ) {}

  /** 创建用户与指定伴侣的聊天会话。 */
  create(ownerId: string, input: CreateChat): Promise<Chat> {
    return this.store.locked(ownerId, async (tx) => {
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

  /**
   * 查询聊天详情及当前回复状态。
   *
   * 查询不会触发模型调用，也不代表用户已收到消息。
   */
  get(ownerId: string, id: string): Promise<Chat> {
    return this.store.locked(ownerId, (tx) => this.read(ownerId, id, tx));
  }

  /**
   * 分页查询用户已创建的私聊。
   *
   * 有界 UUID 分页，只包含已经启用聊天的用户私聊。
   */
  list(ownerId: string, input: IdPaginationQuery): Promise<ChatList> {
    return this.store.locked(ownerId, async (tx) => {
      const rows = await this.database.chatThreads.findMany(
        ownerId,
        {
          where: input.afterId ? gt(chatThreads.conversationId, input.afterId) : undefined,
          orderBy: [asc(chatThreads.conversationId)],
          limit: input.limit + 1,
        },
        tx,
      );
      return {
        items: await Promise.all(
          rows.slice(0, input.limit).map((row) => this.read(ownerId, row.conversationId, tx)),
        ),
        nextAfterId: rows.length > input.limit ? rows[input.limit - 1]!.conversationId : null,
      };
    });
  }

  /**
   * 保存并发布用户输入，安排新的回复轮次。
   *
   * 用户输入先保存并发布；同一事务建立回复任务，HTTP 不等待生成。
   */
  async send(ownerId: string, id: string, input: SendChatMessage): Promise<SentChatMessage> {
    let cancelledCallId: string | null = null;
    const result = await this.store.locked(ownerId, async (tx, now) => {
      const thread = await this.thread(ownerId, id, tx);
      const hash = fingerprint({ text: input.text });
      const replay = await this.database.chatRuns.findOne(
        ownerId,
        { where: { conversationId: id, requestId: input.requestId } },
        tx,
      );
      if (replay) {
        if (replay.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        const message = await this.database.messages.findById(ownerId, replay.triggerMessageId, tx);
        return {
          message: await toMessage(ownerId, this.database, message!, tx),
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
        const oldRun = await this.database.chatRuns.findById(ownerId, thread.currentRunId, tx);
        if (!['succeeded', 'failed', 'cancelled', 'blocked'].includes(previous.status)) {
          firstUserSequence = oldRun!.firstUserSequence;
          if (!oldRun!.context) batchStartedAt = oldRun!.batchStartedAt;
          await this.database.chatRuns.update(ownerId, previous.id, { interruptedAt: now }, tx);
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
      await this.database.tasks.insert(
        ownerId,
        {
          id: runId,
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
        },
        tx,
      );
      await this.database.chatRuns.insert(
        ownerId,
        {
          id: runId,
          conversationId: id,
          triggerMessageId: message.id,
          firstUserSequence,
          batchStartedAt,
          configuration: settings,
          requestId: input.requestId,
          fingerprint: hash,
        },
        tx,
      );
      await this.database.chatThreads.updateWhere(
        ownerId,
        { where: { conversationId: id }, set: { currentRunId: runId } },
        tx,
      );
      return { message, run: await this.run(ownerId, runId, tx) };
    });
    if (cancelledCallId) await this.models.cancel(ownerId, cancelledCallId).catch(() => undefined);
    return result;
  }

  /**
   * 分页查询聊天的原文历史。
   *
   * 最近一页原文按时间正序展示，向前分页不一次加载全部聊天。
   */
  history(ownerId: string, id: string, input: ChatMessageQuery): Promise<ChatMessageList> {
    return this.store.locked(ownerId, async (tx) => {
      await this.thread(ownerId, id, tx, false);
      await requireConversation(ownerId, id, tx);
      const rows = await this.database.messages.findMany(
        ownerId,
        {
          where: and(
            eq(messages.conversationId, id),
            eq(messages.state, 'published'),
            input.beforeSequence ? lt(messages.sequence, input.beforeSequence) : undefined,
          ),
          orderBy: [desc(messages.sequence)],
          limit: input.limit + 1,
        },
        tx,
      );
      return {
        items: await this.messageItems(ownerId, tx, rows.slice(0, input.limit).reverse()),
        nextBeforeSequence: rows.length > input.limit ? rows[input.limit - 1]!.sequence : null,
      };
    });
  }

  /**
   * 返回当前生效的聊天资源配置。
   *
   * 普通配置可公开查看，不包含模型凭据；部署修改后新轮次才采用。
   */
  settings(): ChatConfiguration {
    return this.configuration.chatConfiguration ?? chatConfigurationSchema.parse({});
  }

  /**
   * 查询指定发布序号之后的聊天事件。
   *
   * 从确切发布序号之后读取事件，每次最多 50 条；不会推进送达状态。
   */
  after(ownerId: string, id: string, afterSequence: number): Promise<ChatMessage[]> {
    return this.store.locked(ownerId, async (tx) => {
      await this.thread(ownerId, id, tx, false);
      await requireConversation(ownerId, id, tx);
      const rows = await this.database.messages.findMany(
        ownerId,
        {
          where: and(
            eq(messages.conversationId, id),
            eq(messages.state, 'published'),
            gt(messages.sequence, afterSequence),
          ),
          orderBy: [asc(messages.sequence)],
          limit: 50,
        },
        tx,
      );
      return this.messageItems(ownerId, tx, rows);
    });
  }

  /**
   * 保存终端对聊天原文的送达回执。
   *
   * 逐条核对本会话原文版本，所有回执同事务提交，重复确认不更新时间。
   */
  acknowledge(ownerId: string, id: string, input: ChatDelivery): Promise<null> {
    return this.store.locked(ownerId, async (tx) => {
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

  /**
   * 停止指定回复轮次并撤销执行租约。
   *
   * 停止目标轮次并立即撤销租约；网络中止在事务提交之后尝试。
   */
  async stop(ownerId: string, id: string, input: StopChat): Promise<Chat> {
    const callId = await this.store.locked(ownerId, async (tx, now) => {
      const thread = await this.thread(ownerId, id, tx);
      const run = await this.database.chatRuns.findOne(
        ownerId,
        { where: { conversationId: id, id: input.runId } },
        tx,
      );
      if (!run) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      if (run.interruptedAt) return null;
      if (thread.currentRunId !== run.id) throw new ApiException(API_CODES.VERSION_CONFLICT);
      const job = await this.jobs.getInTransaction(ownerId, run.id, tx);
      if (['succeeded', 'failed', 'cancelled', 'blocked'].includes(job.status)) return null;
      await this.database.chatRuns.update(ownerId, run.id, { interruptedAt: now }, tx);
      return (await this.jobs.controlInTransaction(ownerId, tx, now, run.id, 'cancel')).modelCallId;
    });
    if (callId) await this.models.cancel(ownerId, callId).catch(() => undefined);
    return this.get(ownerId, id);
  }

  /** 将聊天原文记录转换为消息响应。 */
  private async messageItems(
    ownerId: string,
    tx: DatabaseTransaction,
    rows: (typeof messages.$inferSelect)[],
  ): Promise<ChatMessage[]> {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
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
        message: await toMessage(ownerId, this.database, row, tx),
        runId: row.chatRunId,
        deliveredAt:
          deliveries.find((item) => item.messageId === row.id)?.deliveredAt.toISOString() ?? null,
      })),
    );
  }

  /** 读取并校验指定聊天会话。 */
  private async thread(
    ownerId: string,
    id: string,
    tx: DatabaseTransaction,
    active = true,
  ): Promise<typeof chatThreads.$inferSelect> {
    const thread = await this.database.chatThreads.findOne(
      ownerId,
      { where: { conversationId: id } },
      tx,
    );
    if (!thread) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    if (active) {
      await requireCompanion(this.database, ownerId, thread.companionId, thread.runtimeEpoch, tx);
      await requireConversation(ownerId, id, tx);
    }
    return thread;
  }

  /** 组装聊天详情和当前轮次状态。 */
  private async read(ownerId: string, id: string, tx: DatabaseTransaction): Promise<Chat> {
    const thread = await this.thread(ownerId, id, tx, false);
    const companion = await this.database.companions.findById(ownerId, thread.companionId, tx);
    const conversation = await this.database.conversations.findById(ownerId, id, tx);
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
      companionName: companion?.name ?? null,
      avatar:
        companion && !companion.deletedAt ? publicAvatar(companion.id, companion.avatar) : null,
      runtimeEpoch: thread.runtimeEpoch,
      currentRun:
        availability === 'active' && thread.currentRunId
          ? await this.run(ownerId, thread.currentRunId, tx)
          : null,
      lastSequence: conversation!.lastSequence,
      createdAt: thread.createdAt.toISOString(),
    };
  }

  /** 将聊天轮次及任务记录转换为响应数据。 */
  private async run(ownerId: string, id: string, tx: DatabaseTransaction): Promise<ChatRun> {
    const row = await this.database.chatRuns.findById(ownerId, id, tx);
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
