<template>
  <CompanionLayout>
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
        <button class="button button--primary" :disabled="loading || saving" @click="organizeNow">
          现在整理
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
      <section class="persona-page__panel" aria-label="整理进度">
        <h2>整理进度</h2>
        <p v-if="batches?.configuration.enabled" class="persona-page__muted">
          自动整理已开启 · 停聊 {{ batches.configuration.idleMs / 1000 }} 秒或累积
          {{ batches.configuration.messageThreshold }} 条时开始，最长等待
          {{ batches.configuration.maxWaitMs / 60000 }} 分钟。
        </p>
        <p v-else-if="batches" class="persona-page__muted">
          自动整理已关闭。可以点击「现在整理」提前安排一个批次。
        </p>
        <p v-if="!batches?.items.length">尚无整理批次。</p>
        <article v-for="batch in batches?.items" :key="batch.id" class="memory-page__entry">
          <h3>{{ batch.sourceCount }} 条原文 · {{ taskLabel(batch.status) }}</h3>
          <p v-if="batch.mode === 'test'" class="persona-page__badge">
            测试模式：验证保存与进度，返回空候选，不代表真实提取效果。
          </p>
          <p v-if="batch.reason" class="persona-page__muted">{{ reasonLabel(batch.reason) }}</p>
          <p v-if="batch.outcomes">
            新增 {{ batch.outcomes.add }} · 合并 {{ batch.outcomes.merge }} · 修订
            {{ batch.outcomes.revise }} · 分歧 {{ batch.outcomes.conflict }} · 暂不成条目
            {{ batch.outcomes.defer }}
          </p>
          <button
            v-if="canRetry(batch)"
            class="button button--secondary"
            :disabled="loading || saving"
            @click="organize(batch.id)"
          >
            重新整理这一批
          </button>
        </article>
        <button
          v-if="batches?.nextAfterId"
          class="button button--quiet"
          :disabled="loading || saving"
          @click="moreBatches"
        >
          下一页整理记录
        </button>
        <button
          v-if="batchAfter"
          class="button button--quiet"
          :disabled="loading || saving"
          @click="firstBatches"
        >
          回到记录首页
        </button>
      </section>
    </div>
  </CompanionLayout>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { API_CODES } from '@memory-weave/contracts';
import type { MemoryBatch } from '@memory-weave/contracts';
import CompanionLayout from '@/components/CompanionLayout.vue';
import { useMemories } from '@/composables/useMemories';
const route = useRoute();
const companionId = computed(() => String(route.params.id));
const conversationId = computed(() => String(route.params.conversationId));
const epoch = computed(() => Number(route.query.runtimeEpoch));
const chatLink = computed(() => `/chats/${conversationId.value}`);
const {
  items,
  batches,
  detail,
  source,
  next,
  error,
  loading,
  saving,
  refresh,
  organize,
  more,
  inspect,
  moreVersions,
  moreEvidence,
  memoryAfter,
  batchAfter,
  first,
  moreBatches,
  firstBatches,
  showSource,
} = useMemories(companionId, conversationId, epoch);
const sortedVersions = computed(() =>
  [...(detail.value?.versions ?? [])].sort((a, b) => b.version - a.version),
);
/** 显式唤醒不参与逐条批准。 */
function organizeNow(): void {
  void organize();
}
/** 未知外部结果保留阻塞，不能用新身份重复请求。 */
function canRetry(batch: MemoryBatch): boolean {
  return (
    !batch.completedAt &&
    ['failed', 'blocked', 'cancelled'].includes(batch.status) &&
    batch.reason !== 'model_result_unknown'
  );
}
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
/** 当前批次的持久执行状态。 */
function taskLabel(status: string): string {
  return (
    (
      {
        queued: '等待整理',
        running: '正在整理',
        waiting: '等待重试',
        paused: '已暂停',
        blocked: '等待处理',
        succeeded: '整理完成',
        failed: '整理失败',
        cancelled: '已取消',
      } as Record<string, string>
    )[status] ?? status
  );
}
/** 失败信息不展示原始模型错误或私有正文。 */
function reasonLabel(reason: string): string {
  return (
    (
      {
        memory_configuration_required:
          '升级前的记忆配置尚未启用。可重新整理这一批以启用新定义，保留原模型与预算。',
        memory_input_too_large: '单条原文超过整理输入上限，请调整集中配置后重试。',
        model_result_unknown: '供应商结果尚不确定，已停止重发。',
        scope_changed: '来源、权限或伴侣代次已变化。',
        [`api_${API_CODES.MODEL_OUTPUT_INVALID}`]: '模型候选未通过来源或结构校验，未采用任何条目。',
        [`api_${API_CODES.VERSION_CONFLICT}`]: '模型配置已变化，请重新整理。',
      } as Record<string, string>
    )[reason] ?? '本批尚未完成，可检查任务与模型配置后重新整理。'
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
