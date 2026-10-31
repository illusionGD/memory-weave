<template>
  <section class="memory-graph" aria-label="局部记忆关系图">
    <div class="memory-graph__toolbar">
      <span>{{ nodes.length }} 个已展开节点 · {{ edges.length }} 条关系</span
      ><button class="button button--secondary" type="button" @click="fit">适应画布</button>
    </div>
    <p class="memory-graph__legend">
      蓝色：记忆与版本 · 灰色：原文 ·
      橙色虚线：推测内容或普通依赖。连线表示保存过的关联，不代表主张已获证实。
    </p>
    <p v-if="loadError" class="notice notice--error" role="alert">
      图形暂未加载，仍可使用下方节点和关系列表。
    </p>
    <div
      ref="container"
      class="memory-graph__canvas"
      role="img"
      aria-label="记忆、版本和原文的关系图"
    ></div>
    <details class="memory-graph__text" open>
      <summary>节点与关系（可键盘操作）</summary>
      <div class="memory-graph__nodes">
        <button
          v-for="node in nodes"
          :key="node.id"
          class="button button--secondary"
          :disabled="loading"
          @click="emit('select', node)"
        >
          {{ node.label
          }}<span v-if="node.record">
            · {{ node.record.document?.text.slice(0, 26) ?? '正文已清除' }}</span
          >
        </button>
      </div>
      <ul>
        <li v-for="edge in edges" :key="edge.id">
          <span
            >{{ nodeLabel(edge.source) }} → {{ nodeLabel(edge.target) }} ·
            <strong>{{ MEMORY_EDGE_LABELS[edge.kind] }}</strong></span
          >
          <blockquote v-if="edge.quote">{{ edge.quote }}</blockquote>
        </li>
      </ul>
    </details>
  </section>
</template>
<script setup lang="ts">
import { onMounted, onScopeDispose, ref, watch } from 'vue';
import type { Core, ElementDefinition } from 'cytoscape';
import type { MemoryGraphNode, MemoryGraphEdge } from '@memory-weave/contracts';
import { MEMORY_EDGE_LABELS } from '@/utils/memory-labels';
const props = defineProps<{
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  center: string;
  loading: boolean;
}>();
const emit = defineEmits<{ select: [node: MemoryGraphNode] }>();
const container = ref<HTMLDivElement | null>(null);
const loadError = ref(false);
let graph: Core | null = null;
let resize: ResizeObserver | null = null;
let disposed = false;
/** 图形只是同一数据的另一种展示，完整含义也保留在可访问的文本列表中。 */
function render(): void {
  if (!graph) return;
  const elements: ElementDefinition[] = [
    ...props.nodes.map((node) => ({
      data: {
        id: node.id,
        label: node.label,
        kind: node.kind,
        inference: node.record?.document?.epistemic === 'inference' ? 'yes' : 'no',
      },
    })),
    ...props.edges.map((edge) => ({ data: { ...edge, label: MEMORY_EDGE_LABELS[edge.kind] } })),
  ];
  graph.batch(() => {
    graph!.elements().remove();
    graph!.add(elements);
  });
  graph
    .layout({
      name: 'breadthfirst',
      directed: true,
      padding: 36,
      spacingFactor: 1.15,
      animate: false,
      roots: [props.center],
    })
    .run();
}
/** 仅在用户操作或尺寸变化时重新适应，不启动持续动画。 */
function fit(): void {
  graph?.resize();
  graph?.fit(undefined, 36);
}
/** 节点文本使用稳定身份找回，名称相同不自动合并。 */
function nodeLabel(id: string): string {
  return props.nodes.find((node) => node.id === id)?.label ?? '节点';
}
onMounted(async () => {
  try {
    const { default: cytoscape } = await import('cytoscape');
    if (disposed || !container.value) return;
    const tokens = getComputedStyle(container.value);
    const accent = tokens.getPropertyValue('--color-accent').trim();
    const ink = tokens.getPropertyValue('--color-ink').trim();
    const soft = tokens.getPropertyValue('--color-ink-soft').trim();
    const warning = tokens.getPropertyValue('--color-warning').trim();
    graph = cytoscape({
      container: container.value,
      elements: [],
      minZoom: 0.25,
      maxZoom: 3,
      wheelSensitivity: 0.25,
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            'background-color': accent,
            color: ink,
            'font-size': 12,
            'text-valign': 'bottom',
            'text-margin-y': 8,
            width: 36,
            height: 36,
          },
        },
        {
          selector: 'node[kind="message"]',
          style: { 'background-color': soft, shape: 'round-rectangle' },
        },
        { selector: 'node[kind="memory"]', style: { width: 46, height: 46 } },
        {
          selector: 'node[inference="yes"]',
          style: {
            'background-color': warning,
            'border-style': 'dashed',
            'border-width': 2,
            'border-color': warning,
          },
        },
        {
          selector: 'edge',
          style: {
            label: 'data(label)',
            width: 1.5,
            'curve-style': 'bezier',
            'target-arrow-shape': 'triangle',
            'line-color': soft,
            'target-arrow-color': soft,
            color: soft,
            'font-size': 10,
            'text-rotation': 'autorotate',
            'text-margin-y': -7,
          },
        },
        {
          selector: 'edge[kind="dependency"], edge[kind="context"]',
          style: {
            'line-style': 'dashed',
            'line-color': warning,
            'target-arrow-color': warning,
            color: warning,
          },
        },
      ],
    });
    graph.on('tap', 'node', (event) => {
      if (props.loading) return;
      const node = props.nodes.find((item) => item.id === event.target.id());
      if (node) emit('select', node);
    });
    resize = new ResizeObserver(() => graph?.resize());
    resize.observe(container.value);
    render();
  } catch {
    if (!disposed) loadError.value = true;
  }
});
watch([() => props.nodes, () => props.edges], render);
onScopeDispose(() => {
  disposed = true;
  resize?.disconnect();
  graph?.destroy();
  graph = null;
});
</script>
<style scoped lang="scss">
.memory-graph {
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  padding: var(--space-4);
  &__toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    justify-content: space-between;
    align-items: center;
    font-size: 13px;
  }
  &__legend {
    color: var(--color-ink-soft);
    font-size: 12px;
    line-height: 1.7;
  }
  &__canvas {
    height: 380px;
    width: 100%;
    background: var(--color-canvas);
    border-radius: var(--radius-sm);
  }
  &__text {
    font-size: 12px;
    overflow-wrap: anywhere;
    margin-top: var(--space-4);
  }
  &__nodes {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin: var(--space-3) 0;
  }
  &__nodes button {
    text-align: left;
    white-space: normal;
    overflow-wrap: anywhere;
    max-width: 100%;
  }
  ul {
    padding-left: var(--space-4);
    display: grid;
    gap: var(--space-3);
  }
  blockquote {
    margin: var(--space-2) 0;
    color: var(--color-ink-soft);
    white-space: pre-wrap;
  }
}
@media (max-width: 700px) {
  .memory-graph__canvas {
    height: 300px;
  }
}
</style>
