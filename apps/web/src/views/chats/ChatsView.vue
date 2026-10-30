<template>
  <ChatLayout>
    <section class="persona-page">
      <header class="persona-page__intro">
        <p class="eyebrow">那些还想继续的话</p>
        <h1 class="persona-page__title">私聊</h1>
        <p class="persona-page__muted">留一点时间，给相处。让未说完的话，在这里慢慢继续。</p>
        <RouterLink class="button button--primary" to="/companions">选择伴侣</RouterLink>
      </header>
      <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
      <p v-if="loading" role="status">正在读取私聊…</p>
      <p v-else-if="!chats.length" class="persona-page__muted">
        还没有私聊，从一位伴侣的「开始聊天」进入。
      </p>
      <article v-for="chat in chats" :key="chat.id" class="conversation-card">
        <CompanionAvatar
          :name="chat.companionName ?? chat.title"
          :avatar="chat.avatar"
          :size="52"
        />
        <div>
          <h2>{{ chat.title }}</h2>
          <p>
            {{
              chat.availability === 'archived'
                ? '留存的片刻'
                : chat.availability === 'cleaning'
                  ? '正在清理内容'
                  : '故事，等你接着说'
            }}
          </p>
        </div>
        <RouterLink class="button button--secondary" :to="`/chats/${chat.id}`">继续聊天</RouterLink>
      </article>
      <button v-if="nextAfterId" class="button button--quiet" :disabled="loading" @click="more">
        更多私聊
      </button>
    </section>
  </ChatLayout>
</template>

<script setup lang="ts">
import CompanionAvatar from '@/components/CompanionAvatar.vue';
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import type { Chat } from '@memory-weave/contracts';
import ChatLayout from '@/components/ChatLayout.vue';
import { listChats } from '@memory-weave/browser-client/chats';
import { usePersonaPage } from '@/composables/usePersonaPage';
import '@/assets/styles/personas.scss';
const { loading, error, run } = usePersonaPage();
const chats = ref<Chat[]>([]);
const nextAfterId = ref<string | null>(null);
/** 按页追加会话列表，离开页面后拒绝迟到响应。 */
async function more(): Promise<void> {
  const result = await run(() => listChats(nextAfterId.value ?? undefined));
  if (result) {
    chats.value.push(...result.items);
    nextAfterId.value = result.nextAfterId;
  }
}
onMounted(more);
</script>

<style scoped lang="scss">
.conversation-card {
  display: flex;
  align-items: center;
  gap: 22px;
  padding: 26px 28px;
  border: 1px solid var(--color-border);
  border-radius: 18px;
  background: var(--color-surface);
}
.conversation-card h2 {
  font: 21px var(--font-display);
  overflow-wrap: anywhere;
}
.conversation-card p {
  font-size: 12px;
  margin-top: 8px;
  color: var(--color-ink-soft);
}
.conversation-card .button {
  margin-left: auto;
  flex: none;
}
@media (max-width: 600px) {
  .conversation-card {
    padding: 20px;
    gap: 14px;
    flex-wrap: wrap;
  }
  .conversation-card .button {
    margin: 0 0 0 56px;
  }
}
</style>
