<template>
  <ChatLayout>
    <div class="persona-page">
      <section class="persona-page__intro">
        <p class="eyebrow">Lives taking shape</p>
        <h1 class="persona-page__title">伴侣</h1>
        <p class="persona-page__muted">从一段人设开始，保留各自的起点，让往后的经历慢慢发生。</p>
      </section>
      <div class="persona-page__toolbar">
        <RouterLink class="button button--primary" to="/companions/new">创建伴侣</RouterLink>
        <button class="button button--quiet" :disabled="loading" @click="refresh">刷新列表</button>
      </div>
      <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
      <p v-if="loading" role="status">正在读取伴侣…</p>
      <section v-if="!loading && !items.length && !error" class="persona-page__panel">
        <h2>还没有伴侣</h2>
        <p class="persona-page__muted">不必先填写复杂表格，写下你希望认识的那个人就好。</p>
      </section>
      <div class="persona-page__grid">
        <article v-for="companion in items" :key="companion.id" class="persona-page__card">
          <div class="companion-avatar" aria-hidden="true">{{ companion.name.slice(0, 1) }}</div>
          <h2 class="persona-page__card-title">{{ companion.name }}</h2>
          <p class="persona-page__muted">
            {{ companion.currentPersonaVersion.document ? '初始人格已建立' : '原稿已保存' }}
          </p>
          <p class="persona-page__text">
            {{ companion.initialSnapshot.profileText.slice(0, 120)
            }}{{ companion.initialSnapshot.profileText.length > 120 ? '…' : '' }}
          </p>
          <RouterLink class="button button--secondary" :to="`/companions/${companion.id}`"
            >查看 {{ companion.name }}</RouterLink
          >
        </article>
      </div>
      <button v-if="nextAfterId" class="button button--secondary" :disabled="loading" @click="more">
        加载更多伴侣
      </button>
    </div>
  </ChatLayout>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import type { CompanionDetail } from '@memory-weave/contracts';
import ChatLayout from '@/components/ChatLayout.vue';
import { usePersonaPage } from '@/composables/usePersonaPage';
import { listCompanions } from '@memory-weave/browser-client/personas';
const { loading, error, run } = usePersonaPage();
const items = ref<CompanionDetail[]>([]);
const nextAfterId = ref<string | null>(null);
onMounted(refresh);
/** 刷新从第一页开始，保留服务端稳定游标。 */
async function refresh(): Promise<void> {
  const result = await run(() => listCompanions());
  if (result) {
    items.value = result.items;
    nextAfterId.value = result.nextAfterId;
  }
}
/** 仅在用户请求时读取下一页。 */
async function more(): Promise<void> {
  if (!nextAfterId.value) return;
  const result = await run(() => listCompanions(nextAfterId.value!));
  if (result) {
    items.value.push(...result.items);
    nextAfterId.value = result.nextAfterId;
  }
}
</script>
