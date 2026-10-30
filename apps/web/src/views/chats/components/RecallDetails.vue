<template>
  <details class="recall-details">
    <summary>本轮参考的记忆与新消息</summary>
    <section aria-label="本轮回忆来源" class="recall-details__content">
      <p>
        这次回应参考了 {{ recall.memories.length }} 条记忆、{{ recall.pending.length }}
        条尚未整理的新消息。
      </p>
      <p v-if="!recall.coverage.pendingComplete" class="notice notice--error" role="status">
        还有部分新内容未能核对，涉及这些内容时需要保留不确定性。
      </p>
      <p
        v-if="recall.coverage.vector === 'unavailable' || recall.coverage.vector === 'unknown'"
        class="recall-details__note"
      >
        部分回忆暂时未能取得，本轮保留了可用记录和新消息。
      </p>
      <p v-if="recall.coverage.candidateLimitReached" class="recall-details__note">
        本轮只选取了有限材料，没有查到不代表从未发生。
      </p>
      <article
        v-for="memory in recall.memories"
        :key="memory.versionId"
        class="recall-details__item"
      >
        <p class="recall-details__note">
          {{ memory.current ? '当前认识' : '历史版本' }} ·
          {{ memory.status === 'disputed' ? '仍有分歧' : '有来源的记录'
          }}<span v-if="memory.document.reality === 'fictional'">
            · 创作：{{ memory.document.storyKey }}</span
          >
        </p>
        <p>{{ memory.document.text }}</p>
        <blockquote
          v-for="(evidence, index) in memory.evidence"
          :key="`${evidence.messageId}:${index}`"
        >
          {{ evidence.quote }}
        </blockquote>
        <RouterLink
          :to="{
            name: 'memories',
            params: { id: companionId, conversationId: memory.conversationId },
            query: { runtimeEpoch },
          }"
          >查看这段对话的记忆与历史</RouterLink
        >
      </article>
      <article
        v-for="source in recall.pending"
        :key="source.messageId"
        class="recall-details__item"
      >
        <p class="recall-details__note">
          {{ source.speaker === 'user' ? '用户原话' : '伴侣发言' }} · 收到于
          <time :datetime="source.receivedAt">{{ displayTime(source.receivedAt) }}</time>
        </p>
        <p class="recall-details__original">{{ source.text }}</p>
      </article>
      <p v-if="!recall.memories.length && !recall.pending.length" class="recall-details__note">
        这次使用当前聊天内容，没有额外选入回忆材料。
      </p>
    </section>
  </details>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';
import type { RecallResult } from '@memory-weave/contracts';
defineProps<{
  /** 本轮固定的实际来源及覆盖限制。 */
  recall: RecallResult;
  /** 来源所属伴侣，与当前聊天保持一致。 */
  companionId: string;
  /** 回查时携带精确人生代次。 */
  runtimeEpoch: number;
}>();
/** 显示本地收到时间，不把收到时间当作事实发生时间。 */
function displayTime(value: string): string {
  return new Date(value).toLocaleString();
}
</script>

<style scoped lang="scss">
.recall-details {
  margin: var(--space-3) 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  overflow-wrap: anywhere;
  font-size: 0.85rem;
  summary {
    cursor: pointer;
    color: var(--color-accent);
  }
  &__content {
    max-height: 24rem;
    overflow-y: auto;
    padding-top: var(--space-3);
  }
  &__item {
    padding: var(--space-3) 0;
    border-top: 1px solid var(--color-border);
  }
  &__note {
    color: var(--color-ink-soft);
    font-size: 0.8rem;
  }
  &__original {
    white-space: pre-wrap;
  }
  blockquote {
    margin: var(--space-2) 0;
    padding-left: var(--space-3);
    border-left: 2px solid var(--color-border);
    color: var(--color-ink-soft);
    white-space: pre-wrap;
  }
}
</style>
