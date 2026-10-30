<template>
  <ChatLayout>
    <section class="chat-view">
      <header class="chat-view__header">
        <RouterLink class="chat-view__back button button--quiet" to="/chats" aria-label="全部私聊"
          >‹</RouterLink
        >
        <RouterLink
          v-if="chat"
          :to="`/companions/${chat.companionId}`"
          class="chat-view__profile"
          aria-label="查看伴侣资料"
        >
          <CompanionAvatar
            :avatar="chat.avatar"
            :name="chat.companionName ?? chat.title"
            :size="44"
          />
        </RouterLink>
        <div class="chat-view__identity">
          <h1>{{ chat?.companionName ?? chat?.title ?? '正在打开私聊…' }}</h1>
          <p class="chat-view__connection" role="status">
            {{
              connected
                ? '此刻，与你同在'
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
          aria-label="这段对话的记忆"
          :to="{
            name: 'memories',
            params: { id: chat.companionId, conversationId: chat.id },
            query: { runtimeEpoch: chat.runtimeEpoch },
          }"
          >回忆</RouterLink
        >
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
          <span aria-hidden="true">✧</span>
          <h2>从今天想聊的开始</h2>
          <p>一句近况，一个念头，或只是打个招呼。</p>
        </div>
        <article
          v-for="bubble in bubbles"
          :key="bubble.id"
          class="chat-view__message"
          :class="{ 'chat-view__message--user': bubble.user }"
        >
          <CompanionAvatar
            v-if="!bubble.user"
            class="chat-view__bubble-avatar"
            :avatar="chat?.avatar"
            :name="chat?.companionName ?? '伴侣'"
            :size="32"
          />
          <div class="chat-view__bubble-body">
            <p class="chat-view__speaker">
              {{ bubble.user ? '你' : (chat?.companionName ?? '伴侣') }}
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
          </div>
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
          placeholder="把想说的话，轻轻放在这里…"
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
import CompanionAvatar from '@/components/CompanionAvatar.vue';
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
  max-width: 920px;
  height: 100%;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
}
.chat-view__header {
  display: flex;
  flex: none;
  align-items: center;
  gap: 14px;
  padding-bottom: 22px;
  padding-right: 98px;
  border-bottom: 1px solid var(--color-border);
}
.chat-view__identity {
  flex: 1;
  min-width: 0;
}
.chat-view h1 {
  margin: 0;
  font: 500 21px/1.5 var(--font-body);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.chat-view__header .button {
  font-size: 13px;
  min-height: 36px;
  padding: 7px 12px;
}
.chat-view__header .chat-view__back {
  font-size: 28px;
  padding: 0 8px;
}
.chat-view__profile {
  display: inline-flex;
  text-decoration: none;
}
.chat-view__connection {
  color: var(--color-ink-soft);
  font-size: 11px;
  margin-top: 4px;
}
.chat-view__mode {
  flex: none;
  color: var(--color-ink-soft);
  font-size: 11px;
  padding: 7px 12px;
  background: var(--color-surface);
  border-radius: var(--radius-sm);
  margin-top: 10px;
}
.chat-view__history {
  display: flex;
  flex: none;
  gap: 8px;
}
.chat-view__history .button {
  font-size: 12px;
  min-height: 30px;
  padding: 4px 10px;
}
.chat-view__log {
  flex: 1;
  min-height: 60px;
  overflow-y: auto;
  padding: 30px 4px 12px;
  scroll-behavior: auto;
}
.chat-view__empty {
  padding: 12vh 16px 32px;
  text-align: center;
  color: var(--color-ink-soft);
}
.chat-view__empty span {
  color: var(--color-accent);
  font-size: 2rem;
}
.chat-view__empty h2 {
  font: 500 24px/1.8 var(--font-display);
  color: var(--color-ink);
  margin: 16px 0 10px;
}
.chat-view__empty p {
  font-size: 13px;
}
.chat-view__message {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: fit-content;
  max-width: 82%;
  margin: 0 auto 22px 0;
}
.chat-view__bubble-avatar {
  margin-top: 23px;
}
.chat-view__bubble-body {
  min-width: 0;
}
.chat-view__message--user {
  margin-left: auto;
  margin-right: 0;
}
.chat-view__message--user .chat-view__text {
  background: var(--color-bubble-user);
  border-radius: 14px 4px 14px 14px;
}
.chat-view__message--user .chat-view__speaker {
  justify-content: flex-end;
}
.chat-view__speaker {
  color: var(--color-ink-soft);
  font-size: 10px;
  display: flex;
  gap: 12px;
  margin: 0 0 7px;
}
.chat-view__text {
  margin: 0;
  padding: 14px 19px;
  border-radius: 4px 14px 14px 14px;
  background: var(--color-bubble);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.9;
  font-size: 14px;
}
.chat-view__delete {
  min-height: 26px;
  padding: 3px 5px;
  font-size: 10px;
  color: var(--color-ink-soft);
  opacity: 0;
}
.chat-view__message:hover .chat-view__delete,
.chat-view__message:focus-within .chat-view__delete {
  opacity: 1;
}
.chat-view__status {
  flex: none;
  min-height: 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--color-ink-soft);
  font-size: 11px;
}
.chat-view__status .button {
  font-size: 12px;
  min-height: 30px;
  padding: 5px 10px;
}
.chat-view__composer {
  flex: none;
  padding: 14px 18px;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--color-surface);
}
.chat-view__input {
  display: block;
  width: 100%;
  min-height: 44px;
  max-height: 120px;
  padding: 4px 0;
  resize: none;
  border: 0;
  background: transparent;
  color: var(--color-ink);
  font: inherit;
  font-size: 14px;
}
.chat-view__input::placeholder {
  color: var(--color-ink-soft);
}
.chat-view__input:focus-visible {
  outline-offset: 2px;
  outline-width: 1px;
}
.chat-view__actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}
.chat-view__actions p {
  margin: 0;
  font-size: 10px;
  color: var(--color-ink-soft);
}
.chat-view__actions .button {
  flex-shrink: 0;
  min-height: 36px;
  padding: 6px 24px;
  font-size: 13px;
  font-weight: 500;
}
@media (max-width: 560px) {
  .chat-view__header {
    gap: 10px;
    padding-bottom: 16px;
    padding-right: 66px;
  }
  .chat-view h1 {
    font-size: 18px;
  }
  .chat-view__header .button {
    padding: 6px 8px;
    font-size: 12px;
  }
  .chat-view__header .chat-view__back {
    font-size: 28px;
    padding: 0;
  }
  .chat-view__connection {
    font-size: 10px;
  }
  .chat-view__message {
    max-width: 94%;
    margin-bottom: 16px;
    gap: 9px;
  }
  .chat-view__text {
    padding: 11px 14px;
  }
  .chat-view__composer {
    padding: 11px 14px;
  }
  .chat-view__actions p {
    font-size: 9px;
  }
  .chat-view__delete {
    opacity: 0.7;
  }
}
</style>
