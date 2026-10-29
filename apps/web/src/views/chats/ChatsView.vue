<template>
  <CompanionLayout>
    <section class="persona-page">
      <header class="persona-page__intro">
        <p class="eyebrow">Conversations to return to</p>
        <h1 class="persona-page__title">私聊</h1>
        <p class="persona-page__muted">接着上次的话题，或去伴侣页面开始一段新对话。</p>
        <RouterLink class="button button--primary" to="/companions">选择伴侣</RouterLink>
      </header>
      <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
      <p v-if="loading" role="status">正在读取私聊…</p>
      <p v-else-if="!chats.length" class="persona-page__muted">
        还没有私聊，从一位伴侣的「开始聊天」进入。
      </p>
      <article v-for="chat in chats" :key="chat.id" class="persona-page__panel">
        <h2>{{ chat.title }}</h2>
        <RouterLink class="button button--secondary" :to="`/chats/${chat.id}`">继续聊天</RouterLink>
      </article>
      <button v-if="nextAfterId" class="button button--quiet" :disabled="loading" @click="more">
        更多私聊
      </button>
    </section>
  </CompanionLayout>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import type { Chat } from '@memory-weave/contracts';
import CompanionLayout from '@/components/CompanionLayout.vue';
import { listChats } from '@/services/chats';
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
