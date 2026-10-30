import { API_CODES } from '@memory-weave/contracts';
import type { ModelConfigurationVersion, RecallResult } from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, desc, lte, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  chatRuns,
  chatRunSources,
  chatMemorySources,
  chatSegments,
  chatThreads,
  companions,
  messages,
  modelCalls,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { ConversationsService } from '../conversations/conversations.service';
import {
  requireConversation,
  requireCompanionMember,
  assertVisible,
} from '../conversations/conversation-access';
import { ModelConfigurationService } from '../models/model-configuration.service';
import { ModelProvidersService } from '../models/model-providers.service';
import { ModelRuntimeService } from '../models/model-runtime.service';
import { TasksService } from '../tasks/tasks.service';
import { TaskStore } from '../tasks/task-store';
import type { TaskLease } from '../tasks/task-types';
import { chatDefinition, chatDefinitionV1, CHAT_DEFINITION_VERSION } from './chat-definition';
import { RetrievalService } from '../retrieval/retrieval.service';
import { validateRecallSnapshot } from '../retrieval/retrieval-snapshot';
import { recallQuerySchema } from '@memory-weave/contracts';
import { createHash } from 'node:crypto';
import { ChatContextService } from './chat-context.service';

/** 持久任务执行聊天；每次发布均重查当前轮次和租约，迟到输出无法写入。 */
@Injectable()
export class ChatExecutionService {
  constructor(
    @Inject(RetrievalService) private readonly retrieval: RetrievalService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(TasksService) private readonly jobs: TasksService,
    @Inject(ModelRuntimeService) private readonly models: ModelRuntimeService,
    @Inject(ModelConfigurationService) private readonly configuration: ModelConfigurationService,
    @Inject(ModelProvidersService) private readonly providers: ModelProvidersService,
    @Inject(ConversationsService) private readonly originals: ConversationsService,
    @Inject(ChatContextService) private readonly contexts: ChatContextService,
  ) {}

  /** 同一持久轮次始终使用同一模型请求身份；恢复只接续已确认结果的未发布部分。 */
  async execute(lease: TaskLease): Promise<void> {
    const saved = await this.store.locked((ownerId, tx) => this.guard(ownerId, tx, lease));
    const config =
      saved.context && saved.modelConfigVersion
        ? await this.configuration.getVersion(saved.modelConfigVersion)
        : await this.activateDefinition();
    const definition =
      config.config.tasks.chat.promptVersion === 'chat-v1' ? chatDefinitionV1 : chatDefinition;
    const recall = !saved.context ? await this.recall(lease, saved) : undefined;
    const prepared = await this.store.locked(async (ownerId, tx) => {
      const run = await this.guard(ownerId, tx, lease);
      const built = await this.contexts.prepare(ownerId, tx, lease, run, config, recall);
      if (!run.context) {
        await tx
          .insert(chatRunSources)
          .values(
            [
              ...built.context.sources,
              ...(built.context.recall?.querySources ?? []).map((source) => ({
                messageId: source.messageId,
                contentVersion: source.contentVersion,
              })),
              ...(built.context.recall?.pending ?? []).map((source) => ({
                messageId: source.messageId,
                contentVersion: source.contentVersion,
              })),
            ].map((source) => ({ ownerId, runId: run.id, ...source })),
          )
          .onDuplicateKeyUpdate({ set: { runId: run.id } });
        if (built.context.recall?.memories.length)
          await tx
            .insert(chatMemorySources)
            .values(
              built.context.recall.memories.map((item) => ({
                ownerId,
                runId: run.id,
                versionId: item.versionId,
              })),
            )
            .onDuplicateKeyUpdate({ set: { runId: run.id } });
        await tx
          .update(chatRuns)
          .set({
            context: built.context,
            modelConfigVersion: config.version,
            mode: config.config.tasks.chat.providerId === 'test' ? 'test' : 'model',
            transport: this.providers.supportsStreaming(config.config.tasks.chat.providerId)
              ? 'stream'
              : 'buffered',
          })
          .where(and(eq(chatRuns.ownerId, ownerId), eq(chatRuns.id, run.id)));
      }
      return {
        run,
        inputText: built.inputText,
        configVersion: run.modelConfigVersion ?? config.version,
      };
    });
    const initial = await this.store.locked((ownerId, tx) =>
      this.published(ownerId, tx, lease.task.id),
    );
    let emitted = initial;
    let buffer = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: Promise<void> = Promise.resolve();
    let failure: unknown;
    const flush = (): Promise<void> => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const text = buffer;
      buffer = '';
      pending = pending
        .then(async () => {
          if (failure) throw failure;
          for (const part of splitText(text, prepared.run.configuration.publishChunkChars)) {
            await this.publish(lease, part, emitted.length);
            emitted += part;
          }
        })
        .catch((error: unknown) => {
          failure = error;
        });
      return pending;
    };
    try {
      let call = await this.models.executeStreaming(
        {
          requestId: lease.task.id,
          expectedConfigVersion: prepared.configVersion,
          role: 'chat',
          operation: 'text',
          lane: 'interactive',
          inputText: prepared.inputText,
        },
        definition,
        async (delta) => {
          if (failure) throw failure;
          buffer += delta;
          if (!emitted || buffer.length >= prepared.run.configuration.publishChunkChars) {
            await flush();
            if (failure) throw failure;
          } else if (!timer) {
            timer = setTimeout(() => {
              void flush();
            }, prepared.run.configuration.publishIntervalMs);
            timer.unref();
          }
        },
        lease.task.scope,
        async (ownerId, tx) => {
          await this.guard(ownerId, tx, lease);
        },
      );
      // 调用已经失败或被取消时，缓冲中的候选不能在收尾阶段变成正式发言。
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      buffer = '';
      await pending;
      while (call.status === 'running') {
        await delay(lease.config.pollMs);
        await this.jobs.heartbeat(lease);
        call = await this.models.get(call.id);
      }
      await this.jobs.checkpoint(lease, {
        completedSteps: call.status === 'succeeded' ? 1 : 0,
        stage: 'chat_result',
        modelCallId: call.id,
      });
      if (call.status === 'unknown') {
        await this.jobs.block(lease, 'model_result_unknown');
        return;
      }
      if (call.status !== 'succeeded' || call.result?.kind !== 'text') {
        await this.jobs.fail(
          lease,
          call.status === 'cancelled' ? 'model_cancelled' : 'model_failed',
        );
        return;
      }
      if (failure) throw failure;
      if (!call.result.text.startsWith(emitted))
        throw new ApiException(API_CODES.MODEL_OUTPUT_INVALID);
      buffer = call.result.text.slice(emitted.length);
      await flush();
      if (failure) throw failure;
      await this.jobs.complete(lease, async (ownerId, tx) => {
        await this.guard(ownerId, tx, lease);
      });
    } finally {
      if (timer) clearTimeout(timer);
      await pending;
    }
  }

  /** 只用已授权的少量前文理解指代，片段身份随回复来源图保存。 */
  private async recall(lease: TaskLease, run: typeof chatRuns.$inferSelect): Promise<RecallResult> {
    const prepared = await this.store.locked(async (ownerId, tx) => {
      await this.guard(ownerId, tx, lease);
      const member = await requireCompanionMember(
        ownerId,
        lease.task.scope.companionId!,
        lease.task.scope.runtimeEpoch!,
        run.conversationId,
        tx,
      );
      const [source] = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.ownerId, ownerId),
            eq(messages.id, run.triggerMessageId),
            eq(messages.state, 'published'),
            isNull(messages.deletedAt),
          ),
        );
      if (!source?.sequence) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      await assertVisible(member, source.sequence, tx);
      const previous = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.ownerId, ownerId),
            eq(messages.conversationId, run.conversationId),
            eq(messages.state, 'published'),
            isNull(messages.deletedAt),
            lte(messages.sequence, source.sequence - 1),
          ),
        )
        .orderBy(desc(messages.sequence))
        .limit(3);
      for (const item of previous) await assertVisible(member, item.sequence!, tx);
      const sources = previous.reverse().filter((item) => item.text.length > 0);
      return {
        query: recallQuerySchema.parse({
          requestId: recallRequestId(run.id),
          runtimeEpoch: lease.task.scope.runtimeEpoch,
          conversationId: run.conversationId,
          query: source.text,
          context: sources.map((item) => item.text.slice(-512)).join('\n'),
          mode: /以前|过去|当时|曾经|之前|上次|回忆/.test(source.text) ? 'history' : 'ordinary',
          reality: /故事|小说|创作|虚构|角色设定/.test(source.text) ? 'fictional' : 'real',
        }),
        sources: sources.map((item) => ({
          conversationId: run.conversationId,
          messageId: item.id,
          contentVersion: item.contentVersion,
          sequence: item.sequence!,
          permissionVersion: member.permissionVersion,
          startOffset: Math.max(0, item.text.length - 512),
          endOffset: item.text.length,
        })),
      };
    });
    const result = await this.retrieval.recall(
      lease.task.scope.companionId!,
      prepared.query,
      (ownerId, tx) => this.jobs.guardDispatch(ownerId, tx, lease),
    );
    result.querySources = prepared.sources;
    return result;
  }

  /** 派发、片段发布及完成共用同一轮次和人格版本检查。 */
  private async guard(
    ownerId: string,
    tx: DatabaseTransaction,
    lease: TaskLease,
  ): Promise<typeof chatRuns.$inferSelect> {
    await this.jobs.guardDispatch(ownerId, tx, lease);
    const [thread] = await tx
      .select()
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.ownerId, ownerId),
          eq(chatThreads.conversationId, lease.task.scope.conversationId!),
        ),
      );
    const [run] = await tx
      .select()
      .from(chatRuns)
      .where(and(eq(chatRuns.ownerId, ownerId), eq(chatRuns.id, lease.task.id)));
    if (!thread || !run || thread.currentRunId !== run.id || run.interruptedAt)
      throw new ApiException(API_CODES.TASK_LEASE_LOST);
    if (run.context) {
      if (run.context.recall)
        await validateRecallSnapshot(ownerId, lease.task.scope, run.context.recall, tx);
      const [companion] = await tx
        .select()
        .from(companions)
        .where(and(eq(companions.ownerId, ownerId), eq(companions.id, thread.companionId)));
      if (companion?.currentPersonaVersionId !== run.context.personaVersionId)
        throw new ApiException(API_CODES.VERSION_CONFLICT);
    }
    return run;
  }

  /** 片段、原文发布与待整理 outbox 在同一事务提交，不将候选草稿当作已经说出。 */
  private publish(lease: TaskLease, text: string, expectedOffset: number): Promise<void> {
    // 模型取消与片段发布共用配置锁，顺序固定为模型锁 → 调度锁 → 会话锁。
    return this.configuration.locked(async (ownerId, tx) => {
      const run = await this.guard(ownerId, tx, lease);
      const [call] = await tx
        .select()
        .from(modelCalls)
        .where(and(eq(modelCalls.ownerId, ownerId), eq(modelCalls.requestId, run.id)));
      if (!call || !['running', 'succeeded'].includes(call.status))
        throw new ApiException(API_CODES.MODEL_CANCELLED);
      const prefix = await this.published(ownerId, tx, run.id);
      if (prefix.length !== expectedOffset || prefix.length + text.length > 16384)
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      const conversation = await requireConversation(ownerId, run.conversationId, tx, true);
      const requestId = randomUUID();
      const draft = await this.originals.saveInTransaction(
        ownerId,
        tx,
        run.conversationId,
        {
          requestId,
          expectedConversationVersion: conversation.version,
          speaker: {
            kind: 'companion',
            companionId: lease.task.scope.companionId!,
            runtimeEpoch: lease.task.scope.runtimeEpoch!,
          },
          text,
          replyToMessageId: run.triggerMessageId,
          epistemicKind: 'statement',
          reality: 'unspecified',
          sources: [],
        },
        true,
      );
      const message = await this.originals.publishInTransaction(
        ownerId,
        tx,
        run.conversationId,
        draft.id,
        {
          requestId,
          expectedConversationVersion: conversation.version,
          expectedRevision: draft.revision,
        },
      );
      await tx
        .insert(chatSegments)
        .values({ ownerId, messageId: message.id, runId: run.id, position: expectedOffset + 1 });
      await this.guard(ownerId, tx, lease);
    });
  }

  private async published(
    ownerId: string,
    tx: DatabaseTransaction,
    runId: string,
  ): Promise<string> {
    const rows = await tx
      .select({ text: messages.text })
      .from(chatSegments)
      .innerJoin(
        messages,
        and(eq(messages.ownerId, chatSegments.ownerId), eq(messages.id, chatSegments.messageId)),
      )
      .where(and(eq(chatSegments.ownerId, ownerId), eq(chatSegments.runId, runId)))
      .orderBy(asc(chatSegments.position))
      .limit(16384);
    return rows.map((row) => row.text).join('');
  }

  /** 只把旧诊断占位定义绑定到聊天版本，保留供应商、价格、限额与历史。 */
  private async activateDefinition(): Promise<ModelConfigurationVersion> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.configuration.get();
      const chat = current.config.tasks.chat;
      if (
        chat.promptVersion === CHAT_DEFINITION_VERSION &&
        chat.schemaVersion === CHAT_DEFINITION_VERSION &&
        chat.preprocessingVersion === 'utf8-v1'
      )
        return current;
      if (
        !['probe-v1', 'chat-v1'].includes(chat.promptVersion) ||
        !['probe-v1', 'chat-v1'].includes(chat.schemaVersion) ||
        chat.preprocessingVersion !== 'utf8-v1'
      )
        throw new ApiException(API_CODES.MODEL_NOT_CONFIGURED, '聊天定义与 chat 模型配置不一致。');
      try {
        return await this.configuration.update({
          requestId: randomUUID(),
          expectedVersion: current.version,
          config: {
            ...current.config,
            tasks: {
              ...current.config.tasks,
              chat: {
                ...chat,
                promptVersion: CHAT_DEFINITION_VERSION,
                schemaVersion: CHAT_DEFINITION_VERSION,
              },
            },
          },
          evaluationNote: 'F09 新轮次绑定记忆上下文定义，保留模型、价格及限额。',
        });
      } catch (error) {
        if (!(error instanceof ApiException) || error.code !== API_CODES.VERSION_CONFLICT)
          throw error;
      }
    }
    throw new ApiException(API_CODES.VERSION_CONFLICT);
  }
}

/** 按 UTF-16 上限切分但不拆开代理对，避免片段独立传输破坏表情字符。 */
function splitText(text: string, limit: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

/** 检索和聊天各自保留稳定模型调用身份，恢复不会换键重发。 */
function recallRequestId(runId: string): string {
  const hex = createHash('sha256').update(`recall:${runId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
