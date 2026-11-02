<template>
  <ChatLayout>
    <div class="persona-page">
      <section class="persona-page__intro">
        <p class="eyebrow">Lives taking shape</p>
        <h1 class="persona-page__title">伴侣</h1>
        <p class="persona-page__muted">从一段人设开始，保留各自的起点，让往后的经历慢慢发生。</p>
      </section>
      <div class="persona-page__toolbar">
        <UiLink type="primary" to="/companions/new">创建伴侣</UiLink>
        <NButton quaternary :disabled="loading" :loading="loading" @click="refresh"
          >刷新列表</NButton
        >
      </div>
      <NAlert v-if="error" type="error" :show-icon="false">{{ error }}</NAlert>
      <div v-if="loading" class="companions__loading" role="status">
        <NSpin size="small" />正在读取伴侣…
      </div>
      <section v-if="!loading && !items.length && !error" class="persona-page__panel">
        <NEmpty description="还没有伴侣">
          <template #extra
            ><p class="persona-page__muted">
              不必先填写复杂表格，写下你希望认识的那个人就好。
            </p></template
          >
        </NEmpty>
      </section>
      <div class="persona-page__grid">
        <article v-for="companion in items" :key="companion.id" class="persona-page__card">
          <CompanionAvatar :name="companion.name" :avatar="companion.avatar" :size="64" />
          <h2 class="persona-page__card-title">{{ companion.name }}</h2>
          <NTag class="companions__status" :bordered="false" size="small" type="info">
            {{ companion.currentPersonaVersion.document ? '初始人格已建立' : '原稿已保存' }}
          </NTag>
          <p class="persona-page__text">
            {{ companion.initialSnapshot.profileText.slice(0, 120)
            }}{{ companion.initialSnapshot.profileText.length > 120 ? '…' : '' }}
          </p>
          <UiLink class="companions__profile-link" secondary :to="`/companions/${companion.id}`"
            >查看 {{ companion.name }}</UiLink
          >
        </article>
      </div>
      <NButton v-if="nextAfterId" secondary :disabled="loading" :loading="loading" @click="more">
        加载更多伴侣
      </NButton>
    </div>
  </ChatLayout>
</template>

<script setup lang="ts">
import CompanionAvatar from '@/components/CompanionAvatar.vue';
import { onMounted, ref } from 'vue';
import { NAlert, NButton, NEmpty, NSpin, NTag } from 'naive-ui';
import UiLink from '@/components/UiLink.vue';
import type { CompanionDetail } from '@memory-weave/contracts';
import ChatLayout from '@/components/ChatLayout.vue';
import { usePersonaPage } from '@/composables/usePersonaPage';
import { listCompanions } from '@memory-weave/browser-client/personas';
const { loading, error, run } = usePersonaPage();
const items = ref<CompanionDetail[]>([]);
const nextAfterId = ref<string | null>(null);
onMounted(refresh);
/**
 * 刷新伴侣列表的第一页。
 *
 * 刷新从第一页开始，保留服务端稳定游标。
 */
async function refresh(): Promise<void> {
  const result = await run(() => listCompanions());
  if (result) {
    items.value = result.items;
    nextAfterId.value = result.nextAfterId;
  }
}
/**
 * 加载下一页伴侣。
 *
 * 仅在用户请求时读取下一页。
 */
async function more(): Promise<void> {
  if (!nextAfterId.value) return;
  const result = await run(() => listCompanions(nextAfterId.value!));
  if (result) {
    items.value.push(...result.items);
    nextAfterId.value = result.nextAfterId;
  }
}
</script>

<style scoped lang="scss">
.companions__loading {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--color-ink-soft);
}
.companions__status {
  justify-self: start;
}
.companions__profile-link {
  min-width: 0;
  height: auto;
  min-height: 36px;
  white-space: normal;
  line-height: 1.6;
}
</style>
