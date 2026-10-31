<template>
  <section class="memory-details" aria-label="记忆来源与历史">
    <header>
      <h2>来源与历史</h2>
      <span>选中版本 {{ record.version }}</span>
    </header>
    <p class="memory-details__text">{{ record.document?.text ?? '来源已失效，正文已清除。' }}</p>
    <dl class="memory-details__facts">
      <div>
        <dt>版本状态</dt>
        <dd>
          {{ record.isCurrent ? '当前版本' : '历史版本' }} ·
          {{ MEMORY_STATUS_LABELS[record.status] }}
        </dd>
      </div>
      <div>
        <dt>形成方式</dt>
        <dd>{{ MEMORY_OPERATION_LABELS[record.operation] }}</dd>
      </div>
      <div>
        <dt>记下时间</dt>
        <dd>{{ memoryTime(record.learnedAt) }}</dd>
      </div>
      <div>
        <dt>经历时间</dt>
        <dd>{{ record.document?.eventTime ?? '未知' }}</dd>
      </div>
      <div>
        <dt>适用时间</dt>
        <dd>
          {{ record.document?.validFrom ?? '未知' }} 至 {{ record.document?.validUntil ?? '未知' }}
        </dd>
      </div>
      <div v-if="record.document">
        <dt>认识来源</dt>
        <dd>{{ MEMORY_EPISTEMIC_LABELS[record.document.epistemic] }}</dd>
      </div>
      <div v-if="record.document?.storyKey">
        <dt>创作范围</dt>
        <dd>{{ record.document.storyKey }}</dd>
      </div>
    </dl>
    <p v-if="record.reason" class="memory-details__muted">{{ record.reason }}</p>
    <h3>这个版本的原文依据</h3>
    <p v-if="!evidence?.items.length" class="memory-details__muted">当前没有可展示的精确引文。</p>
    <blockquote
      v-for="quote in evidence?.items"
      :key="`${quote.messageId}:${quote.startOffset}:${quote.endOffset}`"
      class="memory-details__quote"
    >
      <p>{{ quote.quote }}</p>
      <button
        class="button button--quiet"
        :disabled="loading"
        @click="emit('source', quote.messageId, quote.contentVersion)"
      >
        查看完整原文
      </button>
    </blockquote>
    <button
      v-if="evidence?.nextAfterId"
      class="button button--secondary"
      :disabled="loading"
      @click="emit('moreEvidence')"
    >
      下一页引文
    </button>
    <h3>本页历史版本</h3>
    <ol class="memory-details__history">
      <li v-for="version in sortedVersions" :key="version.versionId">
        <strong
          >版本 {{ version.version }} · {{ MEMORY_OPERATION_LABELS[version.operation] }}</strong
        ><time :datetime="version.learnedAt">{{ memoryTime(version.learnedAt) }}</time>
        <p>{{ version.document?.text ?? '正文已清除' }}</p>
        <button
          class="button button--quiet"
          :disabled="loading"
          @click="emit('version', version.versionId)"
        >
          在图谱查看版本 {{ version.version }}
        </button>
      </li>
    </ol>
    <button
      v-if="detail?.nextAfterId"
      class="button button--secondary"
      :disabled="loading"
      @click="emit('moreVersions')"
    >
      下一页历史版本
    </button>
    <RouterLink
      class="button button--quiet"
      :to="{
        name: 'memories',
        params: { id: companionId, conversationId: record.conversationId },
        query: { runtimeEpoch },
      }"
      >查看这段会话的整理记录</RouterLink
    >
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { MemoryDetail, MemoryEvidencePage, MemoryExplorerItem } from '@memory-weave/contracts';
import {
  MEMORY_OPERATION_LABELS,
  MEMORY_EPISTEMIC_LABELS,
  MEMORY_STATUS_LABELS,
  memoryTime,
} from '@/utils/memory-labels';
const props = defineProps<{
  record: MemoryExplorerItem;
  detail: MemoryDetail | null;
  evidence: MemoryEvidencePage | null;
  companionId: string;
  runtimeEpoch: number;
  loading: boolean;
}>();
const emit = defineEmits<{
  source: [id: string, version: number];
  moreEvidence: [];
  moreVersions: [];
  version: [id: string];
}>();
const sortedVersions = computed(() =>
  [...(props.detail?.versions ?? [])].sort((a, b) => b.version - a.version),
);
</script>
<style scoped lang="scss">
.memory-details {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-5);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  min-width: 0;
  overflow-wrap: anywhere;
  h2,
  h3,
  p {
    margin: 0;
  }
  h2 {
    font-size: 18px;
  }
  h3 {
    font-size: 14px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  &__text {
    white-space: pre-wrap;
    line-height: 1.8;
  }
  &__muted,
  time,
  header span {
    color: var(--color-ink-soft);
    font-size: 12px;
  }
  &__facts {
    display: grid;
    gap: var(--space-3);
    margin: 0;
    font-size: 13px;
  }
  &__facts div {
    display: grid;
    grid-template-columns: 70px 1fr;
    gap: var(--space-3);
  }
  dt {
    color: var(--color-ink-soft);
  }
  dd {
    margin: 0;
  }
  &__quote {
    border-left: 3px solid var(--color-accent);
    margin: 0;
    padding: var(--space-3);
    background: var(--color-accent-soft);
    white-space: pre-wrap;
  }
  &__history {
    display: grid;
    gap: var(--space-4);
    list-style: none;
    padding: 0;
    margin: 0;
  }
  &__history li {
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-3);
    display: grid;
    gap: var(--space-2);
  }
}
</style>
