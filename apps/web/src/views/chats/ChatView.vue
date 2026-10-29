<template>
  <CompanionLayout>
    <section class="chat-view">
      <header class="chat-view__header">
        <div>
          <p class="eyebrow">A conversation, continued</p>
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
        <div v-if="!bubbles.length && !loading" class="chat-view__empty">
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
        </article>
      </div>
      <div class="chat-view__status">
        <span role="status">{{ statusLabel }}</span>
        <button v-if="canStop" class="button button--quiet" :disabled="saving" @click="stop">
          停止回复
        </button>
      </div>
      <p v-if="replyHint" class="notice notice--error" role="status">{{ replyHint }}</p>
      <form class="chat-view__composer" @submit.prevent="send">
        <label class="chat-view__label" for="chat-message">消息</label>
        <textarea
          id="chat-message"
          v-model="draft"
          class="chat-view__input"
          rows="3"
          maxlength="4000"
          :disabled="!chat"
          placeholder="想说什么都可以，也可以随时补充…"
          @keydown="handleKeydown"
        />
        <div class="chat-view__actions">
          <p>补充消息会让伴侣停下，结合新内容重新接话。</p>
          <button
            class="button button--primary"
            type="submit"
            :disabled="saving || !chat || !draft.trim()"
          >
            {{ saving ? '正在保存…' : '发送' }}
          </button>
        </div>
      </form>
    </section>
  </CompanionLayout>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import CompanionLayout from '@/components/CompanionLayout.vue';
import { useChat } from '@/composables/useChat';
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
} = useChat(id);
const log = ref<HTMLElement | null>(null);
let following = true;

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
  margin: 0 auto;
  &__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-4);
    margin-bottom: var(--space-4);
  }
  h1 {
    margin: var(--space-3) 0;
    font-family: var(--font-display);
    font-size: clamp(1.6rem, 4vw, 2.3rem);
    overflow-wrap: anywhere;
  }
  &__connection,
  &__mode,
  &__speaker {
    color: var(--color-ink-soft);
    font-size: 0.8rem;
  }
  &__mode {
    padding: var(--space-3) var(--space-4);
    background: var(--color-accent-soft);
    border-radius: var(--radius-sm);
  }
  &__history {
    display: flex;
    gap: var(--space-2);
    min-height: var(--space-8);
  }
  &__log {
    height: min(52vh, 540px);
    min-height: 220px;
    overflow-y: auto;
    padding: var(--space-5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    scroll-behavior: auto;
  }
  &__empty {
    padding: var(--space-12) var(--space-2);
    text-align: center;
    color: var(--color-ink-soft);
    span {
      color: var(--color-accent);
      font-size: 2rem;
    }
    h2 {
      font-family: var(--font-display);
      color: var(--color-ink);
      font-weight: 500;
    }
  }
  &__message {
    max-width: 88%;
    margin: 0 auto var(--space-6) 0;
    &--user {
      margin-left: auto;
      margin-right: 0;
      .chat-view__text {
        background: var(--color-accent-soft);
      }
    }
  }
  &__speaker {
    display: flex;
    gap: var(--space-3);
    margin: 0 0 var(--space-2);
  }
  &__text {
    margin: 0;
    padding: var(--space-4);
    border-radius: var(--radius-sm);
    background: var(--color-surface-muted);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.8;
  }
  &__status {
    min-height: var(--space-12);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    color: var(--color-ink-soft);
    font-size: 0.85rem;
  }
  &__composer {
    padding: var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }
  &__label {
    display: block;
    margin-bottom: var(--space-2);
    font-size: 0.9rem;
  }
  &__input {
    display: block;
    width: 100%;
    resize: vertical;
    min-height: 80px;
    max-height: 240px;
    padding: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    color: var(--color-ink);
    font: inherit;
  }
  &__actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-3);
    p {
      margin: 0;
      font-size: 0.8rem;
      color: var(--color-ink-soft);
    }
    button {
      flex-shrink: 0;
    }
  }
  @media (max-width: 560px) {
    &__header {
      align-items: flex-start;
    }
    &__log {
      padding: var(--space-3);
    }
    &__message {
      max-width: 96%;
    }
    &__actions {
      align-items: flex-end;
    }
  }
}
</style>
