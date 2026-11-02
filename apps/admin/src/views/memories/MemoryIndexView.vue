<template>
  <AdminLayout>
    <section class="persona-page">
      <header class="persona-page__intro">
        <h1 class="persona-page__title">记忆记录</h1>
        <p class="persona-page__muted">选择一位伴侣，浏览当前人生阶段的记忆、时间线与来源关系。</p>
      </header>
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
      <div class="persona-page__toolbar">
        <NButton :disabled="loading" :loading="loading" @click="refresh()">刷新列表</NButton>
        <span v-if="loading" role="status">正在读取…</span>
      </div>
      <NDataTable
        aria-label="可浏览记忆的伴侣"
        :columns="columns"
        :data="companions"
        :row-key="companionKey"
        :loading="loading"
        :scroll-x="500"
      >
        <template #empty>
          <NEmpty description="暂无伴侣。创建伴侣并开始交流后，可以在这里查看记忆。" />
        </template>
      </NDataTable>
      <div class="persona-page__toolbar">
        <NButton v-if="next" :disabled="loading" @click="refresh(next)">下一页伴侣</NButton>
        <NButton quaternary :disabled="loading" @click="refresh()">回到第一页</NButton>
      </div>
    </section>
  </AdminLayout>
</template>

<script setup lang="ts">
import { h, onMounted, ref } from 'vue';
import { NAlert, NButton, NDataTable, NEmpty } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import type { CompanionListResponse } from '@memory-weave/contracts';
import { listCompanions } from '@memory-weave/browser-client/personas';
import AdminLayout from '@/components/AdminLayout.vue';
import UiLink from '@/components/UiLink.vue';
import { usePersonaPage } from '@/composables/usePersonaPage';

type CompanionRow = CompanionListResponse['items'][number];
const { loading, error, run } = usePersonaPage();
const companions = ref<CompanionRow[]>([]);
const next = ref<string | null>(null);
const columns: DataTableColumns<CompanionRow> = [
  { title: '伴侣', key: 'name', minWidth: 180 },
  { title: '人生阶段', key: 'runtimeEpoch', width: 120 },
  {
    title: '操作',
    key: 'actions',
    width: 160,
    render: (companion) =>
      h(
        UiLink,
        {
          to: {
            name: 'memory-explorer',
            params: { id: companion.id },
            query: { runtimeEpoch: companion.runtimeEpoch },
          },
          size: 'small',
          tertiary: true,
          type: 'primary',
        },
        { default: () => '浏览记忆' },
      ),
  },
];

onMounted(() => refresh());

/**
 * 获取伴侣表格行的稳定标识。
 * @param companion 当前伴侣记录。
 * @returns 伴侣的唯一标识。
 */
function companionKey(companion: CompanionRow): string {
  return companion.id;
}

/**
 * 加载一页可供浏览记忆的伴侣。
 *
 * 选择器使用服务端分页，每页替换，避免下载全部实例。
 */
async function refresh(afterId?: string): Promise<void> {
  const result = await run(() => listCompanions(afterId));
  companions.value = result?.items ?? [];
  next.value = result?.nextAfterId ?? null;
}
</script>
