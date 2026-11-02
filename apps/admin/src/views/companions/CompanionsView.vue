<template>
  <AdminLayout>
    <div class="persona-page">
      <section class="persona-page__intro">
        <p class="eyebrow">Lives taking shape</p>
        <h1 class="persona-page__title">伴侣管理</h1>
        <p class="persona-page__muted">管理伴侣实例，查看初始人生、人格版本与运行状态。</p>
      </section>
      <div class="persona-page__toolbar">
        <UiLink type="primary" to="/companions/new">创建伴侣</UiLink>
        <UiLink secondary to="/persona-templates">管理人设模板</UiLink>
        <NButton quaternary :disabled="loading" @click="refresh">刷新列表</NButton>
      </div>
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
      <NSpin
        v-if="loading && !items.length"
        size="small"
        role="status"
        description="正在读取伴侣…"
      />
      <NCard
        v-if="!loading && !items.length && !error"
        class="persona-page__panel"
        content-class="persona-page__panel-content"
      >
        <h2>还没有伴侣</h2>
        <NEmpty description="不必先填写复杂表格，写下你希望认识的那个人就好。" />
      </NCard>
      <NDataTable
        v-if="items.length"
        :columns="columns"
        :data="items"
        :row-key="companionKey"
        :loading="loading"
        :scroll-x="760"
        :bordered="false"
        aria-label="伴侣列表"
      />
      <NButton v-if="nextAfterId" secondary :disabled="loading" @click="more">
        加载更多伴侣
      </NButton>
    </div>
  </AdminLayout>
</template>

<script setup lang="ts">
import { NAlert, NButton, NCard, NDataTable, NEmpty, NSpin, NTag } from 'naive-ui';
import UiLink from '@/components/UiLink.vue';
import CompanionAvatar from '@/components/CompanionAvatar.vue';
import { h, onMounted, ref } from 'vue';
import type { DataTableColumns } from 'naive-ui';
import type { CompanionDetail } from '@memory-weave/contracts';
import AdminLayout from '@/components/AdminLayout.vue';
import { usePersonaPage } from '@/composables/usePersonaPage';
import { listCompanions } from '@memory-weave/browser-client/personas';
const { loading, error, run } = usePersonaPage();
const items = ref<CompanionDetail[]>([]);
const nextAfterId = ref<string | null>(null);
const columns: DataTableColumns<CompanionDetail> = [
  {
    title: '伴侣',
    key: 'name',
    width: 230,
    render: (companion) =>
      h('div', { class: 'companion-table__identity' }, [
        h(CompanionAvatar, { name: companion.name, avatar: companion.avatar, size: 32 }),
        h('div', [
          h('strong', companion.name),
          h('small', { class: 'companion-table__id' }, companion.id.slice(0, 8)),
        ]),
      ]),
  },
  {
    title: '初始设定',
    key: 'initialSnapshot.profileText',
    minWidth: 260,
    render: (companion) =>
      companion.initialSnapshot.profileText.slice(0, 80) +
      (companion.initialSnapshot.profileText.length > 80 ? '…' : ''),
  },
  {
    title: '人格状态',
    key: 'status',
    width: 130,
    render: (companion) =>
      h(
        NTag,
        { type: companion.currentPersonaVersion.document ? 'success' : 'info', bordered: false },
        { default: () => (companion.currentPersonaVersion.document ? '已建立' : '原稿已保存') },
      ),
  },
  {
    title: '操作',
    key: 'actions',
    width: 190,
    render: (companion) =>
      h(
        UiLink,
        { to: `/companions/${companion.id}`, text: true, type: 'primary' },
        { default: () => `查看 ${companion.name}` },
      ),
  },
];
onMounted(refresh);
/** 返回伴侣表格行的稳定标识。 */
function companionKey(companion: CompanionDetail): string {
  return companion.id;
}
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
:deep(.companion-table__identity) {
  display: flex;
  align-items: center;
  gap: 12px;
}
:deep(.companion-table__id) {
  display: block;
  color: var(--color-ink-soft);
  font-size: 11px;
  margin-top: 4px;
}
</style>
