<template>
  <ChatLayout>
    <section class="chat-view">
      <header class="chat-view__header">
        <div>
          <p class="eyebrow">此刻，与你</p>
          <h1>{{ chat?.title ?? '正在打开私聊…' }}</h1>
          <p class="chat-view__connection" role="status">
            {{
              connected
                ? '已连接'
                : loading
                  ? '正在连接…'
                  : chat
                    ? '连接中断，正在自动重连…'
                    : '尚未连接'
            }}
          </p>
        </div>
        <RouterLink
          v-if="chat?.availability === 'active'"
          class="button button--quiet"
          :to="{
            name: 'memories',
            params: { id: chat.companionId, conversationId: chat.id },
            query: { runtimeEpoch: chat.runtimeEpoch },
          }"
          >这段对话的记忆</RouterLink
        >
        <RouterLink class="button button--quiet" to="/chats">全部私聊</RouterLink>
      </header>
      <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
      <button v-if="!chat && !loading" class="button button--secondary" @click="reload">
        重新读取私聊
      </button>
      <p v-if="chat?.currentRun?.mode === 'test'" class="chat-view__mode">
        测试模型 · 当前回复用于验证聊天链路
      </p>
      <p v-else-if="chat?.currentRun?.transport === 'buffered'" class="chat-view__mode">
        当前模型会在生成结束后返回整段回复。
      </p>
      <div class="chat-view__history">
        <button
          v-if="canLoadEarlier"
          class="button button--quiet"
          :disabled="loading"
          @click="earlier"
        >
          更早的消息
        </button>
        <button
          v-if="historical"
          class="button button--secondary"
          :disabled="loading"
          @click="latest"
        >
          回到最新消息
        </button>
      </div>
      <div
        ref="log"
        class="chat-view__log"
        role="log"
        aria-label="聊天记录"
        aria-live="polite"
        aria-relevant="additions text"
        tabindex="0"
        @scroll="trackScroll"
      >
        <div
          v-if="!bubbles.length && !loading && chat?.availability === 'active'"
          class="chat-view__empty"
        >
          <span aria-hidden="true">✳</span>
          <h2>从今天想聊的开始</h2>
          <p>一句近况，一个念头，或只是打个招呼。</p>
        </div>
        <article
          v-for="bubble in bubbles"
          :key="bubble.id"
          class="chat-view__message"
          :class="{ 'chat-view__message--user': bubble.user }"
        >
          <p class="chat-view__speaker">
            {{ bubble.user ? '你' : '伴侣' }}
            <time :datetime="bubble.time">{{ displayTime(bubble.time) }}</time>
          </p>
          <p class="chat-view__text">{{ bubble.text }}</p>
          <button
            v-if="bubble.targets.length && chat?.availability !== 'cleaning'"
            class="button button--quiet chat-view__delete"
            :disabled="saving"
            @click="deleteMessage(bubble)"
          >
            删除这条消息
          </button>
        </article>
      </div>
      <div class="chat-view__status">
        <span role="status">{{ statusLabel }}</span>
        <button v-if="canStop" class="button button--quiet" :disabled="saving" @click="stop">
          停止回复
        </button>
      </div>
      <RecallDetails
        v-if="chat?.availability === 'active' && chat.currentRun?.context?.recall"
        :recall="chat.currentRun.context.recall"
        :companion-id="chat.companionId"
        :runtime-epoch="chat.runtimeEpoch"
      />
      <p v-if="chat?.availability === 'cleaning'" class="chat-view__mode" role="status">
        正在清理所选内容，完成后可以继续聊天。
      </p>
      <p v-if="chat?.availability === 'archived'" class="chat-view__mode">
        这个会话属于已结束的人生阶段。请从伴侣页面开始新的私聊。
      </p>
      <p v-if="replyHint" class="notice notice--error" role="status">{{ replyHint }}</p>
      <form class="chat-view__composer" @submit.prevent="send">
        <label class="chat-view__label visually-hidden" for="chat-message">消息</label>
        <textarea
          id="chat-message"
          v-model="draft"
          class="chat-view__input"
          rows="2"
          maxlength="4000"
          :disabled="chat?.availability !== 'active'"
          placeholder="想说什么都可以，也可以随时补充…"
          @keydown="handleKeydown"
        />
        <div class="chat-view__actions">
          <p>Enter 发送 · Shift + Enter 换行</p>
          <button
            class="button button--primary"
            type="submit"
            :disabled="saving || chat?.availability !== 'active' || !draft.trim()"
          >
            {{ saving ? '正在保存…' : '发送' }}
          </button>
        </div>
      </form>
    </section>
  </ChatLayout>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import ChatLayout from '@/components/ChatLayout.vue';
import RecallDetails from './components/RecallDetails.vue';
import { useChat } from '@/composables/useChat';
import type { ChatBubble } from '@/composables/useChat';
const route = useRoute();
const id = computed(() => String(route.params.id));
const {
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
  reload,
  remove,
} = useChat(id);
const log = ref<HTMLElement | null>(null);
let following = true;

/** 选中的已显示片段以及依赖输出会被清除，独立原文保留。 */
async function deleteMessage(bubble: ChatBubble): Promise<void> {
  if (
    !window.confirm(
      '确定删除这条消息中当前显示的片段及其依赖内容吗？清理期间会暂停本会话及相关私聊，独立原文保留。此操作不能撤销。',
    )
  )
    return;
  await remove(bubble);
}
/** 用户向上翻看时不强行滚回底部。 */
function trackScroll(): void {
  const element = log.value;
  if (element) following = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}
/** 保留中文输入法回车确认，Shift+Enter 用于换行。 */
function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
}
/** 使用浏览器本地时间，原始 ISO 时间仍保留在 time 元素。 */
function displayTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
watch(
  () => bubbles.value.at(-1)?.text,
  async () => {
    await nextTick();
    if (following && !historical.value && log.value) log.value.scrollTop = log.value.scrollHeight;
  },
);
</script>

<style scoped lang="scss">
.chat-view {
  max-width: 880px;
  height: 100%;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
}
.chat-view__header {
  display: flex;
  flex: none;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-4);
  margin-bottom: 12px;
}
.chat-view h1 {
  margin: 4px 0;
  font-family: var(--font-display);
  font-size: clamp(20px, 2vw, 28px);
  font-weight: 500;
  overflow-wrap: anywhere;
}
.chat-view__header .button {
  font-size: 12px;
  min-height: 32px;
  padding: 6px 10px;
}
.chat-view__header .eyebrow {
  font-size: 10px;
}
.chat-view__connection,
.chat-view__speaker {
  color: var(--color-ink-soft);
  font-size: 0.8rem;
}
.chat-view__mode {
  flex: none;
  color: var(--color-ink-soft);
  font-size: 11px;
  padding: 8px 12px;
  background: var(--color-accent-soft);
  border-radius: var(--radius-sm);
}
.chat-view__history {
  display: flex;
  flex: none;
  gap: var(--space-2);
}
.chat-view__log {
  flex: 1;
  min-height: 80px;
  overflow-y: auto;
  padding: 20px 4px;
  border-radius: var(--radius-md);
  scroll-behavior: auto;
}
.chat-view__empty {
  padding: var(--space-12) var(--space-2);
  text-align: center;
  color: var(--color-ink-soft);
}
.chat-view__empty span {
  color: var(--color-accent);
  font-size: 2rem;
}
.chat-view__empty h2 {
  font-family: var(--font-display);
  color: var(--color-ink);
  font-weight: 500;
}
.chat-view__message {
  max-width: 88%;
  margin: 0 auto var(--space-6) 0;
}
.chat-view__message--user {
  margin-left: auto;
  margin-right: 0;
}
.chat-view__message--user .chat-view__text {
  background: var(--color-accent-soft);
}
.chat-view__speaker {
  display: flex;
  gap: var(--space-3);
  margin: 0 0 var(--space-2);
}
.chat-view__text {
  margin: 0;
  padding: var(--space-4);
  border-radius: 4px 20px 20px 20px;
  background: var(--color-surface);
  box-shadow: 0 3px 18px rgb(35 60 54 / 3%);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.8;
}
.chat-view__delete {
  min-height: 30px;
  padding: 3px 6px;
  font-size: 11px;
  color: var(--color-ink-soft);
  opacity: 0.65;
}
.chat-view__status {
  flex: none;
  min-height: 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  color: var(--color-ink-soft);
  font-size: 12px;
}
.chat-view__composer {
  flex: none;
  padding: 12px 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: 0 5px 24px #233c3605;
}
.chat-view__input {
  display: block;
  width: 100%;
  min-height: 48px;
  max-height: 120px;
  padding: 4px 0;
  resize: none;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-ink);
  font: inherit;
}
.chat-view__actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  margin-top: 4px;
}
.chat-view__actions p {
  margin: 0;
  font-size: 11px;
  color: var(--color-ink-soft);
}
.chat-view__actions .button {
  flex-shrink: 0;
  min-height: 36px;
  padding: 6px 20px;
}
@media (max-width: 560px) {
  .chat-view__header {
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 0;
    margin-bottom: 8px;
  }
  .chat-view__header > div {
    width: 100%;
  }
  .chat-view__header .eyebrow {
    display: none;
  }
  .chat-view__header .button {
    padding: 4px 8px 4px 0;
    font-size: 11px;
  }
  .chat-view__connection {
    font-size: 10px;
  }
  .chat-view__message {
    max-width: 96%;
    margin-bottom: 16px;
  }
  .chat-view__text {
    padding: 12px;
    font-size: 14px;
  }
  .chat-view__composer {
    padding: 10px 12px;
  }
  .chat-view__actions {
    align-items: flex-end;
  }
}
@media (max-height: 600px) {
  .chat-view__log {
    flex: none;
    height: 45svh;
    min-height: 140px;
  }
}
</style>
