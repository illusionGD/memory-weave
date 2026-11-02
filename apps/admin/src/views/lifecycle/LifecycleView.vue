<template>
  <AdminLayout>
    <div class="persona-page">
      <p class="eyebrow">A deliberate new beginning</p>
      <h1 class="persona-page__title">清理记录</h1>
      <p class="persona-page__muted">
        操作一旦提交，限制立即生效。离开页面不会停止清理，暂停或失败也不会恢复已限制的数据。
      </p>
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
      <NCard
        v-if="operation"
        role="region"
        class="persona-page__panel"
        content-class="persona-page__panel-content"
        aria-label="清理进度"
      >
        <h2>{{ operation.status === 'completed' ? '清理已完成' : '清理尚未完成' }}</h2>
        <p>{{ kindLabel(operation.kind) }}</p>
        <p>
          已完成 {{ operation.completedStages }} / {{ operation.totalStages }} 个阶段，已处理
          {{ operation.processedRecords }} 条记录。
        </p>
        <NProgress
          type="line"
          :percentage="progress"
          :status="operation.status === 'completed' ? 'success' : 'default'"
          :show-indicator="false"
          aria-label="清理阶段进度"
        />
        <p v-if="operation.status !== 'completed'" role="status">{{ taskLabel }}</p>
        <p v-if="operation.kind === 'reset_companion'">
          初始人生已保留。清理完成后，可从新会话开始；旧会话保留为只读历史。
        </p>
        <p v-else-if="operation.kind === 'delete_companion'">
          已删除实例的私有状态；已发布的共同原文及其他伴侣的合法经历保留。
        </p>
        <p v-else>选中的原文及其依赖内容已停止使用；独立原文仍然保留。</p>
        <div class="persona-page__toolbar">
          <NButton v-if="canRetry" type="primary" :disabled="saving" @click="retry">
            继续清理
          </NButton>
          <UiLink
            v-if="operation.kind === 'reset_companion' && operation.status === 'completed'"
            type="primary"
            :to="`/companions/${operation.companionId}`"
            >查看伴侣</UiLink
          >
          <NButton
            v-if="operation.conversationId"
            tag="a"
            secondary
            :href="chatUrl(`/chats/${operation.conversationId}`)"
            target="_blank"
            rel="noopener"
            >在聊天端查看 ↗</NButton
          >
          <UiLink quaternary to="/companions">伴侣列表</UiLink>
        </div>
      </NCard>
      <template v-else>
        <NEmpty v-if="!loading && !items.length" description="暂无清理记录。" />
        <NCard
          v-for="item in items"
          :key="item.id"
          class="persona-page__panel"
          content-class="persona-page__panel-content"
        >
          <UiLink :to="`/lifecycle/${item.id}`"
            >{{ kindLabel(item.kind) }} ·
            {{ item.status === 'completed' ? '已完成' : '尚未完成' }}</UiLink
          >
          <p class="persona-page__muted">{{ new Date(item.createdAt).toLocaleString() }}</p>
        </NCard>
        <NButton v-if="nextAfterId" secondary :disabled="loading" @click="next"> 下一页 </NButton>
      </template>
      <NButton quaternary :disabled="loading || saving" @click="refresh"> 刷新进度 </NButton>
    </div>
  </AdminLayout>
</template>

<script setup lang="ts">
import { NAlert, NButton, NCard, NEmpty, NProgress } from 'naive-ui';
import UiLink from '@/components/UiLink.vue';
import { computed, onScopeDispose, ref, watch } from 'vue';
import { chatUrl } from '@/utils/chat-url';
import { useRoute } from 'vue-router';
import type { LifecycleOperation } from '@memory-weave/contracts';
import AdminLayout from '@/components/AdminLayout.vue';
import { usePersonaPage } from '@/composables/usePersonaPage';
import { useCommandIdentity } from '@/composables/useCommandIdentity';
import {
  getLifecycle,
  listLifecycle,
  retryLifecycle,
} from '@memory-weave/browser-client/lifecycle';
const route = useRoute();
const { loading, saving, error, run } = usePersonaPage();
const identify = useCommandIdentity();
const operation = ref<LifecycleOperation | null>(null);
const items = ref<LifecycleOperation[]>([]);
const nextAfterId = ref<string | null>(null);
const progress = computed(() =>
  operation.value?.totalStages
    ? Math.round((operation.value.completedStages / operation.value.totalStages) * 100)
    : 0,
);
const canRetry = computed(
  () =>
    operation.value?.status === 'pending' &&
    ['failed', 'cancelled', 'blocked', 'paused'].includes(operation.value.task.status),
);
const taskLabel = computed(
  () =>
    ({
      queued: '等待清理',
      running: '正在分批清理',
      waiting: '稍后继续清理',
      paused: '清理已暂停',
      failed: '清理失败，可排查后继续',
      blocked: '清理需要核对，可排查后继续',
      cancelled: '清理已中断，可以继续',
      succeeded: '清理已完成',
    })[operation.value?.task.status ?? 'queued'],
);
let cursor: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
watch(() => route.params.id, change, { immediate: true });
onScopeDispose(() => {
  disposed = true;
  clearTimeout(timer);
});
/**
 * 切换选中的清理记录。
 *
 * 切换记录时立即移除上个操作，避免误恢复其他范围。
 */
async function change(): Promise<void> {
  operation.value = null;
  items.value = [];
  cursor = undefined;
  await refresh();
}
/**
 * 刷新清理记录列表及当前操作进度。
 *
 * 轮询只读取进度，不重新发起删除命令。
 */
async function refresh(): Promise<void> {
  clearTimeout(timer);
  const id = typeof route.params.id === 'string' ? route.params.id : null;
  if (id) {
    const result = await run(() => getLifecycle(id));
    if (result) operation.value = result;
    if (
      !disposed &&
      !error.value &&
      result?.status === 'pending' &&
      ['queued', 'running', 'waiting'].includes(result.task.status)
    )
      timer = setTimeout(refresh, 1000);
  } else {
    const result = await run(() => listLifecycle(cursor));
    if (result) {
      items.value = result.items;
      nextAfterId.value = result.nextAfterId;
    }
  }
}
/** 恢复选中的清理操作。 */
async function retry(): Promise<void> {
  if (!operation.value || !canRetry.value) return;
  const current = operation.value;
  const result = await run(
    () =>
      retryLifecycle(current.id, {
        requestId: identify({ id: current.id, taskId: current.task.id }),
      }),
    true,
  );
  if (result) {
    operation.value = result;
    await refresh();
  }
}
/**
 * 加载下一页清理记录。
 *
 * 保持有界列表，不把所有历史日志累积在浏览器。
 */
async function next(): Promise<void> {
  if (!nextAfterId.value) return;
  cursor = nextAfterId.value;
  await refresh();
}
/** 将清理操作类型转换为显示名称。 */
function kindLabel(kind: LifecycleOperation['kind']): string {
  return {
    reset_companion: '重置伴侣',
    delete_companion: '删除伴侣',
    delete_messages: '删除消息及依赖内容',
  }[kind];
}
</script>
