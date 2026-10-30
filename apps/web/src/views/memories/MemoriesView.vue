<template>
  <ChatLayout>
    <div class="persona-page memory-page">
      <header class="persona-page__intro">
        <p class="eyebrow">What stays with us</p>
        <h1 class="persona-page__title">这段对话留下的记忆</h1>
        <p class="persona-page__muted">
          聊天原文与整理后的记忆分别保存。伴侣会在停聊或累积一定内容后自动整理。
        </p>
        <RouterLink class="button button--quiet" :to="chatLink">回到聊天</RouterLink>
      </header>
      <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
      <div class="persona-page__toolbar">
        <button class="button button--secondary" :disabled="loading || saving" @click="refresh">
          刷新记忆
        </button>
        <span v-if="loading || saving" role="status">正在处理…</span>
      </div>
      <section class="persona-page__panel" aria-label="长期记忆">
        <h2>留下的内容</h2>
        <p v-if="!items.length && !loading" class="persona-page__muted">
          还没有长期条目。普通闲聊也可以不形成记忆。
        </p>
        <article v-for="item in items" :key="item.id" class="memory-page__entry">
          <p class="memory-page__meta">版本 {{ item.version }} · {{ statusLabel(item.status) }}</p>
          <p class="persona-page__text">
            {{ item.document?.text ?? '该版本的来源已失效，正文已清除。' }}
          </p>
          <p v-if="item.document?.reality === 'fictional'" class="persona-page__badge">
            创作设定 · {{ item.document.storyKey }}
          </p>
          <button
            class="button button--quiet"
            :disabled="loading || saving"
            @click="inspect(item.id)"
          >
            查看来源与历史
          </button>
        </article>
        <button
          v-if="next"
          class="button button--quiet"
          :disabled="loading || saving"
          @click="more"
        >
          下一页记忆
        </button>
        <button
          v-if="memoryAfter"
          class="button button--quiet"
          :disabled="loading || saving"
          @click="first"
        >
          回到记忆首页
        </button>
      </section>
      <section v-if="detail" class="persona-page__panel" aria-label="记忆来源与历史">
        <h2>来源与历史</h2>
        <article
          v-for="version in sortedVersions"
          :key="version.versionId"
          class="memory-page__entry"
        >
          <h3>版本 {{ version.version }} · {{ operationLabel(version.operation) }}</h3>
          <p class="persona-page__text">{{ version.document?.text ?? '正文已清除' }}</p>
          <p v-if="version.reason" class="persona-page__muted">{{ version.reason }}</p>
          <p v-if="version.document?.eventTime">经历时间：{{ version.document.eventTime }}</p>
          <p v-if="version.document?.validFrom || version.document?.validUntil">
            适用时间：{{ version.document.validFrom ?? '未知' }} 至
            {{ version.document.validUntil ?? '未知' }}
          </p>
          <p class="memory-page__meta">记下于 {{ new Date(version.learnedAt).toLocaleString() }}</p>
          <div
            v-for="evidence in version.evidence"
            :key="`${evidence.messageId}:${evidence.startOffset}`"
            class="memory-page__evidence"
          >
            <blockquote>{{ evidence.quote }}</blockquote>
            <button
              class="button button--quiet"
              :disabled="loading || saving"
              @click="showSource(evidence.messageId, evidence.contentVersion)"
            >
              查看完整原文
            </button>
          </div>
          <button
            v-if="version.evidenceNextAfterId"
            class="button button--quiet"
            :disabled="loading || saving"
            @click="moreEvidence(version.versionId)"
          >
            更多证据
          </button>
        </article>
        <button
          v-if="detail.nextAfterId"
          class="button button--quiet"
          :disabled="loading || saving"
          @click="moreVersions"
        >
          更多历史版本
        </button>
        <div v-if="source" class="memory-page__source" role="region" aria-label="来源原文">
          <h3>来源原文</h3>
          <p class="persona-page__text">{{ source.text }}</p>
        </div>
      </section>
    </div>
  </ChatLayout>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import ChatLayout from '@/components/ChatLayout.vue';
import { useMemories } from '@/composables/useMemories';
const route = useRoute();
const companionId = computed(() => String(route.params.id));
const conversationId = computed(() => String(route.params.conversationId));
const epoch = computed(() => Number(route.query.runtimeEpoch));
const chatLink = computed(() => `/chats/${conversationId.value}`);
const {
  items,
  detail,
  source,
  next,
  error,
  loading,
  saving,
  refresh,
  more,
  inspect,
  moreVersions,
  moreEvidence,
  memoryAfter,
  first,
  showSource,
} = useMemories(companionId, conversationId, epoch);
const sortedVersions = computed(() =>
  [...(detail.value?.versions ?? [])].sort((a, b) => b.version - a.version),
);
/** 将领域状态转成使用者可理解的文字。 */
function statusLabel(status: string): string {
  return (
    (
      {
        active: '当前有效',
        disputed: '存在分歧，需结合历史理解',
        invalidated: '来源已失效',
      } as Record<string, string>
    )[status] ?? status
  );
}
/** 保留真实变化和原先记错之间的区别。 */
function operationLabel(operation: string): string {
  return (
    (
      {
        add: '新增',
        merge: '补充合并',
        change: '情况变化',
        correction: '纠正旧记录',
        conflict: '保留分歧',
      } as Record<string, string>
    )[operation] ?? operation
  );
}
</script>

<style scoped lang="scss">
.memory-page {
  &__entry {
    display: grid;
    gap: var(--space-3);
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-5);
    overflow-wrap: anywhere;
  }
  &__meta {
    color: var(--color-ink-soft);
    font-size: 0.875rem;
  }
  &__evidence {
    border-left: 3px solid var(--color-border);
    padding-left: var(--space-4);
    white-space: pre-wrap;
  }
  &__source {
    background: var(--color-accent-soft);
    padding: var(--space-5);
    border-radius: var(--radius-sm);
  }
}
</style>
