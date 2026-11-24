<template>
  <NCollapse v-if="materials.length" aria-label="分享材料">
    <NCollapseItem v-for="material in materials" :key="material.id" :title="material.title">
      <NDescriptions size="small" :column="1" label-placement="left">
        <NDescriptionsItem label="处理状态">{{ labels[material.state] }}</NDescriptionsItem>
        <NDescriptionsItem v-if="material.reason" label="原因">{{
          material.reason
        }}</NDescriptionsItem>
        <NDescriptionsItem v-if="material.acquiredAt" label="取得时间">{{
          memoryTime(material.acquiredAt)
        }}</NDescriptionsItem>
        <NDescriptionsItem label="片段数">{{ material.partCount }}</NDescriptionsItem>
      </NDescriptions>
      <NButton size="small" quaternary :loading="loading === material.id" @click="show(material.id)"
        >读取片段</NButton
      >
      <NButton
        v-if="material.kind !== 'web'"
        tag="a"
        size="small"
        quaternary
        :href="`/api/materials/${material.id}/original`"
        >下载原件</NButton
      >
      <p v-if="error === material.id" role="status">暂时无法获取材料片段。</p>
      <div v-if="selected === material.id">
        <p v-for="part in parts" :key="part.position" class="material-sources__part">
          <strong>{{ part.page ? `第 ${part.page} 页` : `片段 ${part.position}` }}</strong>
          {{ part.text ?? (part.region ? '图片区域' : '页面没有可提取的文字层') }}
        </p>
        <NButton v-if="nextAfter" size="small" quaternary @click="show(material.id, nextAfter)"
          >更多片段</NButton
        >
      </div>
    </NCollapseItem>
  </NCollapse>
</template>

<script setup lang="ts">
import type { MaterialPart, MaterialSummary } from '@memory-weave/contracts';
import { listMaterialParts } from '@memory-weave/browser-client/materials';
import { NButton, NCollapse, NCollapseItem, NDescriptions, NDescriptionsItem } from 'naive-ui';
import { ref } from 'vue';
import { memoryTime } from '@/utils/memory-labels';

defineProps<{ materials: MaterialSummary[] }>();
const parts = ref<MaterialPart[]>([]);
const selected = ref('');
const loading = ref('');
const error = ref('');
const nextAfter = ref<number | null>(null);
const labels = {
  pending: '待提取',
  parsed: '已提取',
  partial: '部分提取',
  unavailable: '无法取得',
};

/** 读取当前来源确切版本的下一页结构化片段。 */
async function show(id: string, after = 0): Promise<void> {
  if (loading.value) return;
  loading.value = id;
  error.value = '';
  try {
    const page = await listMaterialParts(id, after);
    parts.value = after ? [...parts.value, ...page.items] : page.items;
    nextAfter.value = page.nextAfter;
    selected.value = id;
  } catch {
    error.value = id;
  } finally {
    loading.value = '';
  }
}
</script>

<style scoped lang="scss">
.material-sources__part {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 14rem;
  overflow: auto;
}
</style>
