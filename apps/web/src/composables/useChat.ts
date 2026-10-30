import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import type { ComputedRef, Ref } from 'vue';
import { useRouter } from 'vue-router';
import { getApiResponseDefinition } from '@memory-weave/contracts';
import type { Chat, ChatMessage, SendChatMessage, LifecycleCommand } from '@memory-weave/contracts';
import {
  acknowledgeChat,
  chatHistory,
  getChat,
  sendChatMessage,
  stopChat,
} from '@memory-weave/browser-client/chats';
import { readChatEvents } from '@memory-weave/browser-client/chat-events';
import type { ChatEvent } from '@memory-weave/browser-client/chat-events';
import { createLifecycle, getLifecycleConversation } from '@memory-weave/browser-client/lifecycle';
import { ApiError } from '@memory-weave/browser-client/http';
import { useAuthStore } from '@/stores/auth';

/** 合并同一轮已发布片段后的展示单元；用户原文保持独立。 */
export interface ChatBubble {
  /** 稳定原文或回复轮次身份。 */
  id: string;
  /** 是否为用户发言。 */
  user: boolean;
  /** 按正式发布顺序拼接的纯文本。 */
  text: string;
  /** 首段正式发布时间。 */
  time: string;
  /** 当前显示且尚未删除的确切片段，最多一页。 */
  targets: { messageId: string; contentVersion: number }[];
}
/** 页面只保存当前页及连接状态，不在浏览器长期保存私密原文。 */
export interface ChatPageState {
  /** 当前私聊持久快照。 */
  chat: Ref<Chat | null>;
  /** 编辑中的用户原文。 */
  draft: Ref<string>;
  /** 已发布原文的合并视图。 */
  bubbles: ComputedRef<ChatBubble[]>;
  /** 页面首次加载或翻页中。 */
  loading: Ref<boolean>;
  /** 正在提交发送或停止命令。 */
  saving: Ref<boolean>;
  /** 当前连接是否可接收消息。 */
  connected: Ref<boolean>;
  /** 正在查看较早的一页。 */
  historical: Ref<boolean>;
  /** 是否还有更早历史。 */
  canLoadEarlier: ComputedRef<boolean>;
  /** 当前轮次可停止。 */
  canStop: ComputedRef<boolean>;
  /** 最新回复的明确状态文案。 */
  statusLabel: ComputedRef<string>;
  /** 本轮失败或未知的受控说明。 */
  replyHint: ComputedRef<string | null>;
  /** 当前页面操作错误。 */
  error: Ref<string | null>;
  /** 发送或使用同一身份重试当前原文。 */
  send(): Promise<void>;
  /** 停止界面所见的回复。 */
  stop(): Promise<void>;
  /** 加载较早的一页历史。 */
  earlier(): Promise<void>;
  /** 回到最新的一页原文。 */
  latest(): Promise<void>;
  /** 首次读取失败后重新打开当前私聊。 */
  reload(): Promise<void>;
  /** 删除确切选择的原文和依赖内容。 */
  remove(bubble: ChatBubble): Promise<void>;
}

/** 消息按身份去重，序号只在事件处理成功后推进；离开或切换会话丢弃迟到结果。 */
export function useChat(id: Ref<string>): ChatPageState {
  const router = useRouter();
  let disposed = false;
  const auth = useAuthStore();
  const chat = ref<Chat | null>(null);
  const items = ref<ChatMessage[]>([]);
  const draft = ref('');
  const loading = ref(true);
  const saving = ref(false);
  const connected = ref(false);
  const historical = ref(false);
  const error = ref<string | null>(null);
  const nextBefore = ref<number | null>(null);
  const terminalId = crypto.randomUUID();
  let generation = 0;
  let controller: AbortController | null = null;
  let cursor = 0;
  let recentEvents: ChatMessage[] = [];
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingCommand: SendChatMessage | null = null;
  let pendingDelete: Extract<LifecycleCommand, { kind: 'delete_messages' }> | null = null;
  const acknowledged = new Set<string>();
  const pendingAcknowledgements = new Map<string, { messageId: string; contentVersion: number }>();
  let acknowledgementRunning = false;
  const bubbles = computed<ChatBubble[]>(() => {
    const result: ChatBubble[] = [];
    for (const item of items.value) {
      const key = item.message.deletedAt ? item.message.id : (item.runId ?? item.message.id);
      const targets = item.message.deletedAt
        ? []
        : [{ messageId: item.message.id, contentVersion: item.message.contentVersion }];
      const previous = result.at(-1);
      if (previous?.id === key) {
        previous.text += item.message.text;
        previous.targets.push(...targets);
      } else
        result.push({
          id: key,
          targets,
          text: item.message.text,
          user: item.message.speaker.kind === 'user',
          time: item.message.publishedAt ?? item.message.receivedAt,
        });
    }
    return result;
  });
  const canLoadEarlier = computed(() => nextBefore.value !== null);
  const canStop = computed(() =>
    Boolean(
      chat.value?.availability === 'active' &&
      chat.value.currentRun &&
      ['queued', 'running', 'waiting', 'paused'].includes(chat.value.currentRun.status),
    ),
  );
  const statusLabel = computed(() => {
    if (chat.value?.availability === 'cleaning') return '正在清理，暂时停止使用';
    if (chat.value?.availability === 'archived') return '历史会话 · 只读';
    const labels: Record<string, string> = {
      queued: '等待回复',
      running: '正在回复',
      waiting: '稍后继续',
      paused: '回复已暂停',
      blocked: '回复需要核对',
      succeeded: '回复已完成',
      failed: '回复未完成',
      cancelled: '回复已取消',
      interrupted: '回复已停止',
    };
    return labels[chat.value?.currentRun?.status ?? ''] ?? '从一句话开始';
  });
  const replyHint = computed(() => {
    const run = chat.value?.currentRun;
    if (!run || !['failed', 'blocked'].includes(run.status)) return null;
    if (run.task.reason === 'model_result_unknown')
      return '这次模型调用结果尚不明确。原文和已发布回复都已保留，没有自动重发。';
    const code = Number(run.task.reason?.match(/^api_(\d+)$/)?.[1]);
    return (
      getApiResponseDefinition(code)?.message ??
      '这次回复没有完整完成，已保存的内容仍然保留。可查看任务记录，或发送新消息继续。'
    );
  });

  /** HTTP 与事件可能交错，持久序号和任务更新时间较旧的快照不能倒退界面。 */
  function adoptState(state: Chat): void {
    const current = chat.value;
    if (current && state.contentRevision < current.contentRevision) return;
    if (
      current &&
      (state.contentRevision !== current.contentRevision ||
        state.availability !== current.availability)
    ) {
      // 立即清空旧展示并使所有在途读取失效，不能继续使用旧页或旧回执缓存。
      void open();
      return;
    }
    if (
      current &&
      (state.lastSequence < current.lastSequence ||
        (state.currentRun?.id === current.currentRun?.id &&
          state.currentRun &&
          current.currentRun &&
          state.currentRun.task.updatedAt < current.currentRun.task.updatedAt))
    )
      return;
    chat.value = state;
  }

  /** 将有效消息合并到当前最新页，同一原文重放不会出现两次。 */
  function merge(item: ChatMessage): void {
    const index = items.value.findIndex((entry) => entry.message.id === item.message.id);
    if (index >= 0) items.value[index] = item;
    else items.value.push(item);
    items.value.sort((left, right) => left.message.sequence! - right.message.sequence!);
    if (items.value.length > 100) {
      items.value = items.value.slice(-100);
      nextBefore.value = items.value[0]!.message.sequence;
    }
  }

  /** 只确认实际呈现在当前页的原文；回执失败不假装已送达，下次取得时可重试。 */
  async function acknowledge(token: number): Promise<void> {
    await nextTick();
    if (token !== generation || chat.value?.availability === 'cleaning') return;
    for (const item of items.value)
      if (!item.message.deletedAt && !acknowledged.has(item.message.id))
        pendingAcknowledgements.set(item.message.id, {
          messageId: item.message.id,
          contentVersion: item.message.contentVersion,
        });
    if (acknowledgementRunning || !pendingAcknowledgements.size) return;
    acknowledgementRunning = true;
    try {
      while (pendingAcknowledgements.size && token === generation) {
        const batch = [...pendingAcknowledgements.values()].slice(0, 100);
        await acknowledgeChat(id.value, { terminalId, messages: batch });
        if (token !== generation) return;
        for (const item of batch) {
          acknowledged.add(item.messageId);
          pendingAcknowledgements.delete(item.messageId);
        }
      }
    } catch {
      /* 送达确认不会影响原文是否已经保存，重连或下一次显示时重试。 */
    } finally {
      acknowledgementRunning = false;
    }
  }

  /** 认证失效离开私人页面；其他错误使用已验证的接口提示。 */
  async function report(cause: unknown, token: number): Promise<void> {
    if (token !== generation) return;
    error.value = cause instanceof ApiError ? cause.message : '连接未完成，请稍后重试。';
    if (cause instanceof ApiError && cause.status === 401) {
      auth.invalidateSession();
      await router.replace({ name: 'login' });
    }
  }

  /** 每次断线带最后处理成功的游标恢复，取消页面不撤销模型生成。 */
  async function connect(token: number, attempt = 0): Promise<void> {
    if (token !== generation || !controller) return;
    try {
      await readChatEvents(
        id.value,
        cursor,
        controller.signal,
        (event: ChatEvent) => {
          if (token !== generation) return;
          if (event.kind === 'state') adoptState(event.chat);
          else if (event.sequence > cursor) {
            recentEvents.push(event.message);
            recentEvents = recentEvents.slice(-100);
            if (!historical.value) merge(event.message);
            cursor = event.sequence;
            void acknowledge(token);
          }
        },
        () => {
          if (token === generation) {
            connected.value = true;
            attempt = 0;
            void acknowledge(token);
          }
        },
      );
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        await report(cause, token);
        return;
      }
    }
    if (token !== generation || controller.signal.aborted) return;
    connected.value = false;
    retryTimer = setTimeout(
      () => {
        void connect(token, attempt + 1);
      },
      Math.min(1000 * 2 ** Math.min(attempt, 5), 30000),
    );
  }

  /** 加载页面快照后再订阅，快照之后发生的消息由持久序号补齐。 */
  async function open(): Promise<void> {
    const token = ++generation;
    controller?.abort();
    if (retryTimer) clearTimeout(retryTimer);
    controller = new AbortController();
    pendingCommand = null;
    pendingDelete = null;
    recentEvents = [];
    acknowledged.clear();
    pendingAcknowledgements.clear();
    chat.value = null;
    items.value = [];
    draft.value = '';
    error.value = null;
    connected.value = false;
    historical.value = false;
    loading.value = true;
    saving.value = false;
    try {
      const state = await getChat(id.value);
      if (token !== generation) return;
      const history =
        state.availability === 'cleaning'
          ? { items: [], nextBeforeSequence: null }
          : await chatHistory(id.value);
      const verified = await getChat(id.value);
      if (token !== generation) return;
      if (
        verified.contentRevision !== state.contentRevision ||
        verified.availability !== state.availability
      ) {
        await open();
        return;
      }
      chat.value = state;
      items.value = history.items;
      nextBefore.value = history.nextBeforeSequence;
      cursor = state.lastSequence;
      void acknowledge(token);
      void connect(token);
    } catch (cause) {
      await report(cause, token);
    } finally {
      if (token === generation) loading.value = false;
    }
  }

  /** 换页保留消息事件游标；历史页不冒充已显示新到达的消息。 */
  async function page(before?: number): Promise<void> {
    const token = generation;
    loading.value = true;
    try {
      const revision = chat.value?.contentRevision;
      const result = await chatHistory(id.value, before);
      const verified = await getChat(id.value);
      if (token !== generation) return;
      if (verified.contentRevision !== revision || verified.availability === 'cleaning') {
        await open();
        return;
      }
      historical.value = before !== undefined;
      items.value = result.items;
      nextBefore.value = result.nextBeforeSequence;
      if (before === undefined) {
        const last = result.items.at(-1)?.message.sequence ?? 0;
        for (const item of recentEvents) if (item.message.sequence! > last) merge(item);
      }
      void acknowledge(token);
    } catch (cause) {
      await report(cause, token);
    } finally {
      if (token === generation) loading.value = false;
    }
  }
  /** 读取较早的一页，避免无限堆积浏览器内存。 */
  async function earlier(): Promise<void> {
    if (nextBefore.value && !loading.value) await page(nextBefore.value);
  }
  /** 回到最新页。 */
  async function latest(): Promise<void> {
    if (!loading.value) await page();
  }

  /** 发送失败保留文字和命令身份；确认保存后再次发送相同文字属于新命令。 */
  async function send(): Promise<void> {
    if (saving.value || !draft.value.trim() || chat.value?.availability !== 'active') return;
    const token = generation;
    saving.value = true;
    error.value = null;
    if (!pendingCommand || pendingCommand.text !== draft.value)
      pendingCommand = { requestId: crypto.randomUUID(), text: draft.value };
    const command = pendingCommand;
    try {
      const sent = await sendChatMessage(id.value, command);
      if (token !== generation) return;
      if (historical.value) await page();
      if (token !== generation) return;
      merge({ message: sent.message, runId: null, deliveredAt: null });
      // HTTP 响应可能晚于流事件，不能用旧响应覆盖较新的回复状态。
      const refreshed = await getChat(id.value);
      if (token !== generation) return;
      adoptState(refreshed);
      if (draft.value === command.text) draft.value = '';
      pendingCommand = null;
      void acknowledge(token);
    } catch (cause) {
      await report(cause, token);
    } finally {
      if (token === generation) saving.value = false;
    }
  }
  /** 停止当前所见轮次；发送新补充仍然可以继续聊天。 */
  async function stop(): Promise<void> {
    const runId = chat.value?.currentRun?.id;
    if (!runId || saving.value) return;
    const token = generation;
    saving.value = true;
    try {
      const state = await stopChat(id.value, runId);
      if (token === generation) adoptState(state);
    } catch (cause) {
      await report(cause, token);
    } finally {
      if (token === generation) saving.value = false;
    }
  }
  /** 删除沿用确切选择和命令身份；网络超时重试不会扩大范围。 */
  async function remove(bubble: ChatBubble): Promise<void> {
    if (saving.value || !bubble.targets.length || chat.value?.availability === 'cleaning') return;
    const token = generation;
    saving.value = true;
    error.value = null;
    try {
      const sameTargets =
        pendingDelete && JSON.stringify(pendingDelete.messages) === JSON.stringify(bubble.targets);
      if (!sameTargets) {
        const detail = await getLifecycleConversation(id.value);
        if (token !== generation) return;
        pendingDelete = {
          requestId: crypto.randomUUID(),
          kind: 'delete_messages',
          conversationId: id.value,
          expectedVersion: detail.conversation.version,
          messages: bubble.targets,
        };
      }
      const operation = await createLifecycle(pendingDelete!);
      // 事件可能已触发重读；只在仍停留本会话时更新，离开页面后不再启动请求。
      if (disposed || id.value !== operation.conversationId) return;
      await open();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) pendingDelete = null;
      await report(cause, token);
    } finally {
      if (token === generation) saving.value = false;
    }
  }
  watch(
    id,
    () => {
      void open();
    },
    { immediate: true },
  );
  onScopeDispose(() => {
    disposed = true;
    generation++;
    controller?.abort();
    if (retryTimer) clearTimeout(retryTimer);
  });
  return {
    chat,
    draft,
    bubbles,
    loading,
    saving,
    connected,
    historical,
    canLoadEarlier,
    canStop,
    statusLabel,
    replyHint,
    error,
    send,
    stop,
    earlier,
    latest,
    reload: open,
    remove,
  };
}
