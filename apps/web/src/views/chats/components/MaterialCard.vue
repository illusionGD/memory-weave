<template>
  <NCard class="material-card" size="small" embedded>
    <strong>{{ status.title }}</strong>
    <img
      v-if="image && status.state === 'parsed'"
      :src="`/api/materials/${status.id}/preview`"
      :alt="status.title"
      class="material-card__preview"
      loading="lazy"
    />
    <p role="status">{{ label }}</p>
    <small v-if="status.kind === 'web' && acquiredTime">取得于 {{ acquiredTime }}</small>
    <p v-if="reading?.reason === 'image-not-read'">本轮没有取得图像观察。</p>
    <p
      v-if="
        reading?.requestedPage &&
        !reading.excerpts.some((item) => item.page === reading?.requestedPage)
      "
    >
      本轮没有取得第 {{ reading.requestedPage }} 页的文字。
    </p>
    <p v-if="status.state === 'unavailable' && status.kind === 'web'">
      可粘贴正文，或上传正文文件或截图。
    </p>
    <p v-if="reading?.excerpts.length && finished">
      本轮读到 {{ reading.excerpts.length }} 处文字，共 {{ status.partCount }} 个提取片段。
    </p>
    <p v-if="reading?.observation && finished">
      {{ reading.observation.region ? '局部观察' : '整图概览' }}：{{
        reading.observation.description
      }}
      <small>{{ reading.observation.uncertainty }}</small>
    </p>
    <NSpace size="small">
      <NButton
        v-if="status.partCount"
        size="tiny"
        secondary
        :loading="loading"
        @click="toggleParts"
      >
        {{ expanded ? '收起内容' : '查看内容' }}
      </NButton>
      <NButton
        v-if="status.kind !== 'web'"
        tag="a"
        size="tiny"
        quaternary
        :href="`/api/materials/${status.id}/original`"
        >下载原件</NButton
      >
      <NButton
        v-if="canSummarize && !summary"
        size="tiny"
        quaternary
        :loading="summarizing"
        @click="summarize"
        >总结全文文字</NButton
      >
      <NButton v-if="status.state === 'pending'" size="tiny" quaternary @click="refresh"
        >刷新状态</NButton
      >
      <NButton
        v-if="active && status.state === 'unavailable' && status.sourceUrl"
        size="tiny"
        quaternary
        @click="retryLink"
        >重新分享链接</NButton
      >
    </NSpace>
    <div v-if="summary">
      <p role="status">
        {{ summaryLabel }} · {{ summary.coveredParts }} / {{ summary.totalParts }} 个片段
      </p>
      <NSpace v-if="active" size="small">
        <NButton
          v-if="['queued', 'running', 'waiting'].includes(summary.state)"
          size="tiny"
          quaternary
          :loading="controlling"
          @click="control('pause')"
          >暂停总结</NButton
        >
        <NButton
          v-if="summary.state === 'paused'"
          size="tiny"
          quaternary
          :loading="controlling"
          @click="control('resume')"
          >恢复总结</NButton
        >
        <NButton
          v-if="['queued', 'running', 'waiting', 'paused'].includes(summary.state)"
          size="tiny"
          quaternary
          :loading="controlling"
          @click="control('cancel')"
          >取消总结</NButton
        >
      </NSpace>
      <details v-if="summary.batches.length">
        <summary>查看分批结果</summary>
        <p v-for="(batch, index) in summary.batches" :key="index">
          <small>片段 {{ batch.positions.join('、') }}</small
          ><br />{{ batch.text }}
        </p>
      </details>
    </div>
    <div v-if="expanded" class="material-card__parts">
      <p v-for="part in parts" :key="part.position">
        <small>{{ part.page ? `第 ${part.page} 页` : `片段 ${part.position}` }}</small
        ><br />
        <img
          v-if="part.region"
          :src="`/api/materials/${status.id}/preview?position=${part.position}`"
          alt="材料图片区域"
          loading="lazy"
          class="material-card__preview"
        /><br v-if="part.region" />
        {{ part.text ?? (part.region ? '图片区域' : '本页没有可提取的文字层') }}
      </p>
      <NButton v-if="nextAfter" size="tiny" quaternary :loading="loading" @click="loadParts"
        >更多片段</NButton
      >
    </div>
    <p v-if="error" role="status">{{ error }}</p>
  </NCard>
</template>

<script setup lang="ts">
import type {
  MaterialContext,
  MaterialPart,
  MaterialSummary,
  MaterialSummaryProgress,
} from '@memory-weave/contracts';
import {
  controlMaterialSummary,
  getMaterial,
  latestMaterialSummary,
  listMaterialParts,
  summarizeMaterial,
} from '@memory-weave/browser-client/materials';
import { NButton, NCard, NSpace } from 'naive-ui';
import { computed, onScopeDispose, ref, watch } from 'vue';

const props = defineProps<{
  material: MaterialSummary;
  reading?: MaterialContext;
  finished: boolean;
  scheduledSummary?: string;
  messageId: string;
  contentVersion: number;
  active: boolean;
}>();
const emit = defineEmits<{ retryLink: [url: string] }>();
const status = ref(props.material);
const summary = ref<MaterialSummaryProgress | null>(null);
const summarizing = ref(false);
const controlling = ref(false);
let summaryRequestId = crypto.randomUUID();
let summaryPoll: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
const image = computed(() => ['jpeg', 'png', 'webp'].includes(status.value.kind));
const canSummarize = computed(
  () =>
    props.active &&
    !image.value &&
    status.value.partCount > 0 &&
    (status.value.state === 'parsed' || status.value.state === 'partial'),
);
const summaryLabel = computed(() => {
  const value = summary.value;
  if (!value) return '';
  if (value.state === 'succeeded') return value.partial ? '部分材料已总结' : '全文文字总结完成';
  return {
    queued: '总结等待开始',
    running: '正在分批总结',
    waiting: '稍后继续',
    paused: '总结已暂停',
    blocked: '总结需要核对',
    failed: '总结未完成',
    cancelled: '总结已取消',
  }[value.state];
});
const loading = ref(false);
const expanded = ref(false);
const error = ref('');
const parts = ref<MaterialPart[]>([]);
const nextAfter = ref<number | null>(0);
let polling: ReturnType<typeof setInterval> | undefined;
let attempts = 0;
const acquiredTime = computed(() =>
  status.value.acquiredAt
    ? new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(status.value.acquiredAt))
    : '',
);
const label = computed(() => {
  if (status.value.reason === 'video-unread') return '仅取得视频页面信息，视频未读取';
  if (status.value.reason === 'pdf-pages-without-text') return '部分 PDF 页没有文字层';
  if (status.value.reason === 'original-unavailable') return '原件缺失或已损坏';
  return {
    pending: '正在获取网页',
    parsed: '已提取',
    partial: '仅取得部分内容',
    unavailable: '无法读取',
  }[status.value.state];
});

watch(
  () => props.material,
  (value) => {
    if (status.value.state === 'pending' || value.state !== 'pending') status.value = value;
  },
);

if (status.value.state === 'pending')
  polling = setInterval(() => {
    if (++attempts > 20) {
      clearInterval(polling);
      return;
    }
    void refresh();
  }, 2000);
watch(
  canSummarize,
  (allowed) => {
    if (allowed) void refreshSummary();
  },
  { immediate: true },
);
watch(
  () => props.scheduledSummary,
  (id) => {
    if (id && canSummarize.value && !summary.value) void refreshSummary();
  },
);
onScopeDispose(() => {
  disposed = true;
  clearInterval(polling);
  clearTimeout(summaryPoll);
});

/** 读取最近一次分批结果，等待期间继续刷新持久状态。 */
async function refreshSummary(): Promise<void> {
  try {
    summary.value = await latestMaterialSummary(
      status.value.id,
      props.messageId,
      props.contentVersion,
    );
    if (
      !disposed &&
      summary.value &&
      ['queued', 'running', 'waiting'].includes(summary.value.state)
    )
      summaryPoll = setTimeout(() => void refreshSummary(), 2000);
  } catch {
    error.value = '暂时无法读取总结进度。';
  }
}

/** 更新背景任务状态，暂停与取消保留已覆盖的材料。 */
async function control(action: 'pause' | 'resume' | 'cancel'): Promise<void> {
  if (!summary.value || controlling.value) return;
  clearTimeout(summaryPoll);
  controlling.value = true;
  try {
    await controlMaterialSummary(summary.value.taskId, action);
    await refreshSummary();
  } catch {
    error.value = '暂时无法更新总结任务。';
  } finally {
    controlling.value = false;
  }
}

/** 用户明确为这份材料创建一个背景总结任务。 */
async function summarize(): Promise<void> {
  if (summarizing.value) return;
  summarizing.value = true;
  try {
    summary.value = await summarizeMaterial(status.value.id, {
      requestId: summaryRequestId,
      messageId: props.messageId,
      contentVersion: props.contentVersion,
    });
    summaryRequestId = crypto.randomUUID();
    await refreshSummary();
  } catch {
    error.value = '暂时无法安排全文总结。';
  } finally {
    summarizing.value = false;
  }
}

/** 将原链接交回聊天草稿，下一次发送建立新的独立版本。 */
function retryLink(): void {
  const url = status.value.sourceUrl;
  if (url) emit('retryLink', url);
}

/** 更新材料卡的独立获取状态。 */
async function refresh(): Promise<void> {
  try {
    status.value = await getMaterial(props.material.id);
    if (status.value.state !== 'pending') clearInterval(polling);
  } catch {
    error.value = '暂时无法取得材料状态。';
  }
}

/** 批量请求下一页，避免把整篇原文一次写入聊天历史。 */
async function loadParts(): Promise<void> {
  if (loading.value || nextAfter.value === null) return;
  loading.value = true;
  error.value = '';
  try {
    const page = await listMaterialParts(props.material.id, nextAfter.value);
    parts.value = [...parts.value, ...page.items];
    nextAfter.value = page.nextAfter;
  } catch {
    error.value = '暂时无法读取材料片段。';
  } finally {
    loading.value = false;
  }
}

/** 首次展开时获取第一批片段。 */
async function toggleParts(): Promise<void> {
  expanded.value = !expanded.value;
  if (expanded.value && !parts.value.length) await loadParts();
}
</script>

<style scoped lang="scss">
.material-card {
  margin-block: 0.4rem;
  overflow-wrap: anywhere;
}
.material-card__preview {
  display: block;
  width: auto;
  max-width: min(100%, 14rem);
  max-height: 9rem;
  object-fit: contain;
}
.material-card__parts {
  max-height: 20rem;
  overflow: auto;
  white-space: pre-wrap;
}
</style>
