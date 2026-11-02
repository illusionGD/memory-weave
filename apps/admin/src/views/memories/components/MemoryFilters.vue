<template>
  <NForm class="memory-filters" :show-feedback="false" @submit.prevent="apply">
    <NFormItem label="会话范围" :label-props="{ for: 'memory-conversation' }">
      <NSelect
        v-model:value="draft.conversationId"
        :options="conversationOptions"
        :input-props="{ id: 'memory-conversation' }"
        filterable
        :disabled="loading"
      />
    </NFormItem>
    <NFormItem label="关键词" :label-props="{ for: 'memory-keyword' }">
      <NInput
        v-model:value="draft.q"
        :input-props="{ id: 'memory-keyword', type: 'search' }"
        :maxlength="120"
        placeholder="按记忆正文查找"
        :disabled="loading"
        clearable
      />
    </NFormItem>
    <NCollapse class="memory-filters__advanced" display-directive="show">
      <NCollapseItem name="advanced">
        <template #header="{ collapsed }">
          <NButton text :aria-expanded="!collapsed"
            ><span class="memory-filters__collapse-label"
              >更多筛选（类型、状态与时间）</span
            ></NButton
          >
        </template>
        <div class="memory-filters__grid">
          <NFormItem label="记忆类型" :label-props="{ for: 'memory-kind' }">
            <NSelect
              v-model:value="draft.kind"
              :options="kindOptions"
              :input-props="{ id: 'memory-kind' }"
              filterable
              :disabled="loading"
            />
          </NFormItem>
          <NFormItem label="内容类别" :label-props="{ for: 'memory-claim' }">
            <NSelect
              v-model:value="draft.claim"
              :options="claimOptions"
              :input-props="{ id: 'memory-claim' }"
              filterable
              :disabled="loading"
            />
          </NFormItem>
          <NFormItem label="有效状态" :label-props="{ for: 'memory-status' }">
            <NSelect
              v-model:value="draft.status"
              :options="statusOptions"
              :input-props="{ id: 'memory-status' }"
              filterable
              :disabled="loading"
            />
          </NFormItem>
          <NFormItem label="现实与创作" :label-props="{ for: 'memory-reality' }">
            <NSelect
              v-model:value="draft.reality"
              :options="realityOptions"
              :input-props="{ id: 'memory-reality' }"
              filterable
              :disabled="loading"
            />
          </NFormItem>
          <NFormItem label="故事标识" :label-props="{ for: 'memory-story-key' }">
            <NInput
              v-model:value="draft.storyKey"
              :input-props="{ id: 'memory-story-key' }"
              :maxlength="120"
              placeholder="可选，精确匹配"
              :disabled="loading"
              clearable
            />
          </NFormItem>
          <NFormItem :show-label="false">
            <label class="memory-filters__date-label">
              <span>记下时间从</span>
              <NDatePicker
                v-model:value="from"
                type="datetime"
                format="yyyy-MM-dd HH:mm"
                placeholder="选择开始时间"
                :disabled="loading"
                clearable
              />
            </label>
          </NFormItem>
          <NFormItem :show-label="false">
            <label class="memory-filters__date-label">
              <span>记下时间至</span>
              <NDatePicker
                v-model:value="until"
                type="datetime"
                format="yyyy-MM-dd HH:mm"
                placeholder="选择结束时间"
                :disabled="loading"
                clearable
              />
            </label>
          </NFormItem>
        </div>
      </NCollapseItem>
    </NCollapse>
    <div class="memory-filters__actions">
      <NButton type="primary" :disabled="loading" attr-type="submit">应用筛选</NButton>
      <NButton :disabled="loading" @click="reset">重置筛选</NButton>
      <NButton
        v-if="hasMoreConversations"
        quaternary
        :disabled="loading"
        @click="emit('moreConversations')"
      >
        下一页会话选项
      </NButton>
      <NButton quaternary :disabled="loading" @click="emit('firstConversations')">
        会话选项首页
      </NButton>
    </div>
    <NAlert v-if="validationError" class="memory-filters__error" type="error" role="alert">
      {{ validationError }}
    </NAlert>
  </NForm>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import {
  NAlert,
  NButton,
  NCollapse,
  NCollapseItem,
  NDatePicker,
  NForm,
  NFormItem,
  NInput,
  NSelect,
} from 'naive-ui';
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
});
const from = ref<number | null>(null);
const until = ref<number | null>(null);
const validationError = ref<string | null>(null);
const conversationOptions = computed(() => [
  { value: '', label: '与这位伴侣的全部私聊' },
  ...(draft.conversationId && !props.conversations.some((item) => item.id === draft.conversationId)
    ? [{ value: draft.conversationId, label: '已选择的会话' }]
    : []),
  ...props.conversations.map((item) => ({
    value: item.id,
    label: `${item.title} · ${item.kind === 'group' ? '群聊' : '私聊'} · ${item.id.slice(0, 6)}`,
  })),
]);
const kindOptions = [
  { value: '', label: '全部类型' },
  ...Object.entries(MEMORY_KIND_LABELS).map(([value, label]) => ({ value, label })),
];
const claimOptions = [
  { value: '', label: '全部类别' },
  ...Object.entries(MEMORY_CLAIM_LABELS).map(([value, label]) => ({ value, label })),
];
const statusOptions = [
  { value: '', label: '全部状态' },
  ...Object.entries(MEMORY_STATUS_LABELS).map(([value, label]) => ({ value, label })),
];
const realityOptions = [
  { value: '', label: '全部范围' },
  { value: 'real', label: '现实' },
  { value: 'fictional', label: '创作设定' },
  { value: 'unspecified', label: '尚未明确' },
];

watch(
  () => props.initialConversation,
  (value) => {
    draft.conversationId = value ?? '';
  },
  { immediate: true },
);

/**
 * 校验并提交记忆筛选条件。
 *
 * 日期组件按浏览器本地时区生成时间戳，提交时转换成 UTC；清空日期后移除对应条件。
 */
function apply(): void {
  const values = Object.fromEntries(Object.entries(draft).filter(([, value]) => value.trim()));
  const dates = { from: from.value, until: until.value };
  for (const [key, timestamp] of Object.entries(dates)) {
    if (timestamp === null) continue;
    if (!Number.isFinite(timestamp) || Number.isNaN(new Date(timestamp).getTime())) {
      validationError.value = '筛选条件无效，请检查时间先后和输入内容。';
      return;
    }
    values[key] = new Date(timestamp).toISOString();
  }
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

/**
 * 重置记忆筛选条件并重新查询。
 *
 * 清空条件后重新读取，不沿用旧分页游标。
 */
function reset(): void {
  for (const key of Object.keys(draft) as (keyof typeof draft)[]) draft[key] = '';
  from.value = null;
  until.value = null;
  validationError.value = null;
  emit('apply', {});
}
</script>

<style scoped lang="scss">
.memory-filters {
  &__collapse-label {
    white-space: normal;
    text-align: left;
    overflow-wrap: anywhere;
  }
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
  padding: var(--space-5);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);

  &__advanced,
  &__error {
    grid-column: 1 / -1;
    min-width: 0;
  }

  &__grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-4);
  }

  &__date-label {
    display: grid;
    gap: 6px;
    min-width: 0;
    width: 100%;
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
