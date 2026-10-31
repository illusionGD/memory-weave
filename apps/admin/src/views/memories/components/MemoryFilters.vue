<template>
  <form class="memory-filters" @submit.prevent="apply">
    <label
      >会话范围<select v-model="draft.conversationId" :disabled="loading">
        <option value="">与这位伴侣的全部私聊</option>
        <option
          v-if="
            draft.conversationId && !conversations.some((item) => item.id === draft.conversationId)
          "
          :value="draft.conversationId"
        >
          已选择的会话
        </option>
        <option v-for="item in conversations" :key="item.id" :value="item.id">
          {{ item.title }} · {{ item.kind === 'group' ? '群聊' : '私聊' }} ·
          {{ item.id.slice(0, 6) }}
        </option>
      </select></label
    >
    <label
      >关键词<input
        v-model="draft.q"
        type="search"
        maxlength="120"
        placeholder="按记忆正文查找"
        :disabled="loading"
    /></label>
    <details class="memory-filters__advanced">
      <summary>更多筛选（类型、状态与时间）</summary>
      <div class="memory-filters__grid">
        <label
          >记忆类型<select v-model="draft.kind" :disabled="loading">
            <option value="">全部类型</option>
            <option v-for="(label, value) in MEMORY_KIND_LABELS" :key="value" :value="value">
              {{ label }}
            </option>
          </select></label
        >
        <label
          >内容类别<select v-model="draft.claim" :disabled="loading">
            <option value="">全部类别</option>
            <option v-for="(label, value) in MEMORY_CLAIM_LABELS" :key="value" :value="value">
              {{ label }}
            </option>
          </select></label
        >
        <label
          >有效状态<select v-model="draft.status" :disabled="loading">
            <option value="">全部状态</option>
            <option v-for="(label, value) in MEMORY_STATUS_LABELS" :key="value" :value="value">
              {{ label }}
            </option>
          </select></label
        >
        <label
          >现实与创作<select v-model="draft.reality" :disabled="loading">
            <option value="">全部范围</option>
            <option value="real">现实</option>
            <option value="fictional">创作设定</option>
            <option value="unspecified">尚未明确</option>
          </select></label
        >
        <label
          >故事标识<input
            v-model="draft.storyKey"
            maxlength="120"
            placeholder="可选，精确匹配"
            :disabled="loading"
        /></label>
        <label
          >记下时间从<input v-model="draft.from" type="datetime-local" :disabled="loading"
        /></label>
        <label
          >记下时间至<input v-model="draft.until" type="datetime-local" :disabled="loading"
        /></label>
      </div>
    </details>
    <div class="memory-filters__actions">
      <button class="button button--primary" :disabled="loading" type="submit">应用筛选</button
      ><button class="button button--secondary" :disabled="loading" type="button" @click="reset">
        重置筛选</button
      ><button
        v-if="hasMoreConversations"
        class="button button--quiet"
        :disabled="loading"
        type="button"
        @click="emit('moreConversations')"
      >
        下一页会话选项</button
      ><button
        class="button button--quiet"
        :disabled="loading"
        type="button"
        @click="emit('firstConversations')"
      >
        会话选项首页
      </button>
    </div>
    <p v-if="validationError" class="notice notice--error" role="alert">{{ validationError }}</p>
  </form>
</template>
<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { memoryExplorerQuerySchema } from '@memory-weave/contracts';
import type { MemoryExplorerConversation, MemoryExplorerQuery } from '@memory-weave/contracts';
import {
  MEMORY_KIND_LABELS,
  MEMORY_CLAIM_LABELS,
  MEMORY_STATUS_LABELS,
} from '@/utils/memory-labels';
const props = defineProps<{
  conversations: MemoryExplorerConversation[];
  initialConversation?: string;
  hasMoreConversations: boolean;
  loading: boolean;
}>();
const emit = defineEmits<{
  apply: [value: Partial<MemoryExplorerQuery>];
  moreConversations: [];
  firstConversations: [];
}>();
const draft = reactive({
  conversationId: '',
  q: '',
  kind: '',
  claim: '',
  status: '',
  reality: '',
  storyKey: '',
  from: '',
  until: '',
});
const validationError = ref<string | null>(null);
watch(
  () => props.initialConversation,
  (value) => {
    draft.conversationId = value ?? '';
  },
  { immediate: true },
);
/** 使用公共查询契约校验，日期输入采用浏览器本地时区转换成 UTC。 */
function apply(): void {
  const values = Object.fromEntries(
    Object.entries(draft)
      .filter(([, value]) => value.trim())
      .map(([key, value]) => [
        key,
        key === 'from' || key === 'until' ? new Date(value).toISOString() : value,
      ]),
  );
  const result = memoryExplorerQuerySchema.safeParse({ ...values, runtimeEpoch: 1 });
  if (!result.success) {
    validationError.value = '筛选条件无效，请检查时间先后和输入内容。';
    return;
  }
  validationError.value = null;
  const filters: Partial<MemoryExplorerQuery> = { ...result.data };
  delete filters.runtimeEpoch;
  delete filters.limit;
  emit('apply', filters);
}
/** 清空条件后重新读取，不沿用旧分页游标。 */
function reset(): void {
  for (const key of Object.keys(draft) as (keyof typeof draft)[]) draft[key] = '';
  validationError.value = null;
  emit('apply', {});
}
</script>
<style scoped lang="scss">
.memory-filters {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
  padding: var(--space-5);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  label {
    display: grid;
    gap: var(--space-2);
    color: var(--color-ink-soft);
    font-size: 13px;
    min-width: 0;
  }
  input,
  select {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    background: var(--color-surface);
    color: var(--color-ink);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: 9px 10px;
    font: inherit;
  }
  &__advanced {
    grid-column: 1 / -1;
  }
  &__advanced summary {
    cursor: pointer;
    color: var(--color-ink-soft);
    font-size: 13px;
  }
  &__grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-4);
    padding-top: var(--space-4);
  }
  &__actions {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
}
@media (max-width: 700px) {
  .memory-filters,
  .memory-filters__grid {
    grid-template-columns: 1fr;
  }
}
</style>
