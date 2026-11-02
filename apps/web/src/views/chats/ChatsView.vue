<template>
  <ChatLayout>
    <section class="persona-page">
      <header class="persona-page__intro">
        <p class="eyebrow">那些还想继续的话</p>
        <h1 class="persona-page__title">私聊</h1>
        <p class="persona-page__muted">留一点时间，给相处。让未说完的话，在这里慢慢继续。</p>
        <UiLink type="primary" to="/companions">选择伴侣</UiLink>
      </header>
      <NAlert v-if="error" type="error" :show-icon="false">{{ error }}</NAlert>
      <NSpin v-if="loading" size="small"><span role="status">正在读取私聊…</span></NSpin>
      <NEmpty v-else-if="!chats.length" description="还没有私聊，从一位伴侣的「开始聊天」进入。" />
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
        <UiLink secondary class="conversation-card__link" :to="`/chats/${chat.id}`"
          >继续聊天</UiLink
        >
      </article>
      <NButton v-if="nextAfterId" quaternary :disabled="loading" @click="more"> 更多私聊 </NButton>
    </section>
  </ChatLayout>
</template>

<script setup lang="ts">
import CompanionAvatar from '@/components/CompanionAvatar.vue';
import { onMounted, ref } from 'vue';
import { NAlert, NButton, NEmpty, NSpin } from 'naive-ui';
import UiLink from '@/components/UiLink.vue';
import type { Chat } from '@memory-weave/contracts';
import ChatLayout from '@/components/ChatLayout.vue';
import { listChats } from '@memory-weave/browser-client/chats';
import { usePersonaPage } from '@/composables/usePersonaPage';
import '@/assets/styles/personas.scss';
const { loading, error, run } = usePersonaPage();
const chats = ref<Chat[]>([]);
const nextAfterId = ref<string | null>(null);
/**
 * 加载下一页聊天会话。
 *
 * 按页追加会话列表，离开页面后拒绝迟到响应。
 */
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
.conversation-card__link {
  margin-left: auto;
  flex: none;
}
@media (max-width: 600px) {
  .conversation-card {
    padding: 20px;
    gap: 14px;
    flex-wrap: wrap;
  }
  .conversation-card__link {
    margin: 0 0 0 56px;
  }
}
</style>
