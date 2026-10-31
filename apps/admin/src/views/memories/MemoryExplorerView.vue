<template>
  <AdminLayout>
    <div class="memory-explorer">
      <header class="memory-explorer__intro">
        <div>
          <p class="eyebrow">MEMORY EXPLORER</p>
          <h1>记忆浏览</h1>
          <p>{{ companion?.name ?? '伴侣' }} · 第 {{ epoch }} 段人生 · 查看记忆如何形成与变化</p>
        </div>
        <div class="memory-explorer__actions">
          <RouterLink class="button button--quiet" to="/memories">选择伴侣</RouterLink
          ><button class="button button--primary" :disabled="loading" @click="refresh()">
            刷新记忆
          </button>
        </div>
      </header>
      <MemoryFilters
        :key="`${companionId}:${epoch}`"
        :conversations="conversations"
        :initial-conversation="initialConversation"
        :has-more-conversations="!!conversationsNext"
        :loading="loading"
        @apply="applyFilters"
        @more-conversations="loadConversations(conversationsNext ?? undefined)"
        @first-conversations="loadConversations()"
      />
      <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      <nav class="memory-explorer__tabs" aria-label="记忆视图">
        <button
          v-for="tab in tabs"
          :key="tab.value"
          :aria-pressed="view === tab.value"
          :class="{ 'is-active': view === tab.value }"
          :disabled="loading"
          @click="changeView(tab.value)"
        >
          {{ tab.label }}</button
        ><span v-if="loading" role="status">正在读取…</span>
      </nav>
      <p v-if="view === 'timeline'" class="memory-explorer__hint">
        按记下时间排序；经历时间保留原有描述。
      </p>
      <p v-if="suspended" role="status">正在核对页面内容…</p>
      <div
        v-else
        class="memory-explorer__workspace"
        :class="{ 'memory-explorer__workspace--detail': !!detail || !!source }"
      >
        <section class="memory-explorer__main" aria-label="记忆浏览结果">
          <template v-if="view !== 'graph'">
            <p v-if="!items.length && !loading" class="memory-explorer__empty">
              当前范围还没有符合条件的记忆。
            </p>
            <div
              class="memory-explorer__records"
              :class="{ 'memory-explorer__records--timeline': view === 'timeline' }"
            >
              <article v-for="item in items" :key="item.versionId" class="memory-explorer__record">
                <div class="memory-explorer__meta">
                  <time :datetime="item.learnedAt">{{ memoryTime(item.learnedAt) }}</time
                  ><span :class="{ 'memory-explorer__warning': item.status !== 'active' }">{{
                    MEMORY_STATUS_LABELS[item.status]
                  }}</span
                  ><span>{{ item.isCurrent ? '当前版本' : '历史版本' }} {{ item.version }}</span>
                </div>
                <h2 v-if="view === 'timeline'">{{ MEMORY_OPERATION_LABELS[item.operation] }}</h2>
                <p class="memory-explorer__body">
                  {{ item.document?.text ?? '该版本来源已失效，正文已清除。' }}
                </p>
                <div v-if="item.document" class="memory-explorer__tags">
                  <span>{{ MEMORY_KIND_LABELS[item.document.kind] }}</span
                  ><span>{{ MEMORY_EPISTEMIC_LABELS[item.document.epistemic] }}</span
                  ><span v-if="item.document.reality === 'fictional'"
                    >创作 · {{ item.document.storyKey }}</span
                  ><span v-else-if="item.document.reality === 'unspecified'">现实范围未明确</span>
                </div>
                <p v-if="view === 'timeline'" class="memory-explorer__hint">
                  经历时间：{{ item.document?.eventTime ?? '未知'
                  }}<span v-if="item.document?.validFrom || item.document?.validUntil">
                    · 适用：{{ item.document?.validFrom ?? '未知' }} 至
                    {{ item.document?.validUntil ?? '未知' }}</span
                  >
                </p>
                <div class="memory-explorer__record-footer">
                  <span>{{ item.conversationTitle }}</span>
                  <div class="memory-explorer__actions">
                    <button class="button button--quiet" :disabled="loading" @click="inspect(item)">
                      查看来源与历史</button
                    ><button
                      class="button button--secondary"
                      :disabled="loading"
                      @click="showGraph(item, view === 'timeline' ? 'version' : 'memory')"
                    >
                      查看关系图谱
                    </button>
                  </div>
                </div>
              </article>
            </div>
            <div class="memory-explorer__actions">
              <button
                v-if="next"
                class="button button--secondary"
                :disabled="loading"
                @click="refresh(next)"
              >
                下一页记忆</button
              ><button class="button button--quiet" :disabled="loading" @click="refresh()">
                回到第一页
              </button>
            </div>
          </template>
          <template v-else>
            <div v-if="selected" class="memory-explorer__graph-selection">
              <span
                >选中：版本 {{ selected.version }} ·
                {{ selected.document?.text ?? '正文已清除' }}</span
              >
              <div class="memory-explorer__actions">
                <button
                  class="button button--secondary"
                  :disabled="loading"
                  @click="inspect(selected)"
                >
                  查看选中版本的来源与历史</button
                ><button
                  class="button button--quiet"
                  :disabled="loading"
                  @click="showGraph(selected)"
                >
                  以选中记忆重建图谱
                </button>
              </div>
            </div>
            <MemoryGraph
              v-if="graphNodes.length"
              :nodes="graphNodes"
              :edges="graphEdges"
              :center="graphCenter"
              :loading="loading"
              @select="selectNode"
            />
            <div class="memory-explorer__actions">
              <button
                v-for="(query, center) in graphPages"
                :key="center"
                class="button button--secondary"
                :disabled="loading || graphLimit"
                @click="expandGraph(query)"
              >
                继续展开 {{ centerLabel(String(center)) }}
              </button>
            </div>
            <p class="memory-explorer__hint">
              每次只展开一层关系。图中显示当前已加载的部分，展开会包含相关版本与来源。
            </p>
          </template>
        </section>
        <aside v-if="detail || source" class="memory-explorer__details" aria-label="选中内容详情">
          <MemoryDetails
            v-if="selected && detail"
            :record="selected"
            :detail="detail"
            :evidence="evidence"
            :companion-id="companionId"
            :runtime-epoch="epoch"
            :loading="loading"
            @source="showSource"
            @more-evidence="moreEvidence"
            @more-versions="moreVersions"
            @version="showVersion"
          />
          <section v-if="source" class="memory-explorer__source" aria-label="完整原文">
            <h2>完整原文</h2>
            <p class="memory-explorer__hint">
              接收于 {{ memoryTime(source.receivedAt) }} · 发布于
              {{ memoryTime(source.publishedAt) }}
            </p>
            <p class="memory-explorer__body">{{ source.text }}</p>
          </section>
        </aside>
      </div>
    </div>
  </AdminLayout>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import AdminLayout from '@/components/AdminLayout.vue';
import { useMemoryExplorer } from '@/composables/useMemoryExplorer';
import {
  MEMORY_KIND_LABELS,
  MEMORY_STATUS_LABELS,
  MEMORY_OPERATION_LABELS,
  MEMORY_EPISTEMIC_LABELS,
  memoryTime,
} from '@/utils/memory-labels';
import MemoryFilters from './components/MemoryFilters.vue';
import MemoryDetails from './components/MemoryDetails.vue';
import MemoryGraph from './components/MemoryGraph.vue';
const route = useRoute();
const companionId = computed(() => String(route.params.id));
const epoch = computed(() => Number(route.query.runtimeEpoch));
const initialConversation = computed(() =>
  typeof route.query.conversationId === 'string' ? route.query.conversationId : undefined,
);
const {
  companion,
  conversations,
  conversationsNext,
  view,
  items,
  next,
  selected,
  detail,
  evidence,
  source,
  graphNodes,
  graphEdges,
  graphPages,
  graphCenter,
  graphLimit,
  loading,
  error,
  notice,
  suspended,
  refresh,
  applyFilters,
  changeView,
  inspect,
  moreVersions,
  moreEvidence,
  showSource,
  showGraph,
  showVersion,
  selectNode,
  expandGraph,
  loadConversations,
} = useMemoryExplorer(companionId, epoch, initialConversation);
const tabs = [
  { value: 'entries', label: '记忆列表' },
  { value: 'timeline', label: '时间线' },
  { value: 'graph', label: '关系图谱' },
] as const;
/** 继续展开入口采用可理解的节点名称，稳定身份仍由查询保存。 */
function centerLabel(id: string): string {
  return graphNodes.value.find((node) => node.id === id)?.label ?? '选中节点';
}
</script>
<style scoped lang="scss">
.memory-explorer {
  display: grid;
  gap: var(--space-5);
  min-width: 0;
  &__intro {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
    justify-content: space-between;
    align-items: center;
  }
  &__intro h1 {
    margin: var(--space-2) 0;
    font-size: 26px;
  }
  &__intro p {
    margin: 0;
    color: var(--color-ink-soft);
    font-size: 13px;
  }
  &__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }
  &__tabs {
    display: flex;
    gap: var(--space-4);
    align-items: center;
    border-bottom: 1px solid var(--color-border);
  }
  &__tabs button {
    padding: var(--space-3) 0;
    font: inherit;
    border: 0;
    background: none;
    border-bottom: 2px solid transparent;
    color: var(--color-ink-soft);
    cursor: pointer;
  }
  &__tabs button.is-active {
    border-bottom-color: var(--color-accent);
    color: var(--color-accent);
    font-weight: 600;
  }
  &__workspace {
    display: grid;
    min-width: 0;
    gap: var(--space-5);
  }
  &__workspace--detail {
    grid-template-columns: minmax(0, 1.25fr) minmax(300px, 1fr);
  }
  &__main,
  &__details,
  &__records {
    display: grid;
    gap: var(--space-4);
    min-width: 0;
    align-content: start;
  }
  &__record,
  &__source {
    padding: var(--space-5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    min-width: 0;
    overflow-wrap: anywhere;
  }
  &__record h2,
  &__source h2 {
    font-size: 16px;
    margin: var(--space-3) 0;
  }
  &__meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    color: var(--color-ink-soft);
    font-size: 12px;
  }
  &__body {
    white-space: pre-wrap;
    line-height: 1.8;
    margin: var(--space-3) 0;
  }
  &__tags {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--color-accent);
  }
  &__tags span {
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    background: var(--color-accent-soft);
  }
  &__record-footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-3);
    margin-top: var(--space-4);
  }
  &__record-footer > span,
  &__hint {
    color: var(--color-ink-soft);
    font-size: 12px;
    line-height: 1.7;
    margin: 0;
  }
  &__warning {
    color: var(--color-warning);
  }
  &__empty {
    text-align: center;
    padding: var(--space-12) var(--space-4);
    color: var(--color-ink-soft);
    background: var(--color-surface);
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-md);
  }
  &__records--timeline {
    border-left: 2px solid var(--color-border);
    padding-left: var(--space-5);
  }
  &__graph-selection {
    display: grid;
    gap: var(--space-3);
    font-size: 13px;
    overflow-wrap: anywhere;
  }
}
@media (max-width: 1100px) {
  .memory-explorer__workspace--detail {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 700px) {
  .memory-explorer__tabs {
    gap: var(--space-3);
    font-size: 13px;
  }
  .memory-explorer__records--timeline {
    padding-left: var(--space-3);
  }
}
</style>
