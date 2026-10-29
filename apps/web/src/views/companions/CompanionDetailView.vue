<template>
  <CompanionLayout>
    <div class="persona-page">
      <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
      <p v-if="loading && !state" role="status">正在读取伴侣…</p>
      <template v-if="state">
        <section class="persona-page__intro">
          <p class="eyebrow">A life, with its beginning kept</p>
          <h1 class="persona-page__title">{{ state.companion.name }}</h1>
          <button
            class="button button--primary"
            :disabled="saving || !!state.companion.lifecycleOperationId"
            @click="startChat"
          >
            开始聊天
          </button>
          <p class="persona-page__muted">初始人生作为长期起点保存，当前人格使用独立版本。</p>
        </section>
        <p v-if="state.companion.currentPersonaVersion.mode === 'test'" class="persona-page__badge">
          测试模式：已验证创建与保存流程；当前内容不代表真实模型的语义整理效果。
        </p>
        <section class="persona-page__panel" aria-label="初始整理状态">
          <h2>{{ statusLabel }}</h2>
          <p v-if="statusHint" class="persona-page__muted">{{ statusHint }}</p>
          <div class="persona-page__toolbar">
            <button class="button button--secondary" :disabled="loading || saving" @click="refresh">
              刷新
            </button>
            <button v-if="canPause" class="button button--quiet" :disabled="saving" @click="pause">
              暂停整理
            </button>
            <button
              v-if="state.task?.status === 'paused'"
              class="button button--secondary"
              :disabled="saving"
              @click="resume"
            >
              继续整理
            </button>
            <button
              v-if="canCancel"
              class="button button--quiet"
              :disabled="saving"
              @click="cancel"
            >
              取消整理
            </button>
            <button
              v-if="canInitialize"
              class="button button--primary"
              :disabled="saving"
              @click="initialize"
            >
              {{ state.task ? '重新尝试整理' : '开始整理初始人格' }}
            </button>
          </div>
        </section>
        <section class="persona-page__panel" aria-label="人格版本">
          <div class="persona-page__toolbar">
            <button
              class="button button--secondary"
              :aria-pressed="selection === 'current'"
              @click="showCurrent"
            >
              当前人格
            </button>
            <button
              v-if="state.initialPersonaVersion"
              class="button button--secondary"
              :aria-pressed="selection === 'initial'"
              @click="showInitial"
            >
              初始人格
            </button>
            <label for="persona-history">历史版本</label>
            <input
              id="persona-history"
              v-model.number="historyNumber"
              class="persona-page__input companion-detail__version"
              type="number"
              min="1"
              :max="state.companion.currentPersonaVersion.version"
            />
            <button class="button button--quiet" :disabled="loading || saving" @click="loadHistory">
              查看版本
            </button>
          </div>
          <h2>{{ versionLabel }}</h2>
          <PersonaDocumentView v-if="displayed?.document" :document="displayed.document" />
          <p v-else class="persona-page__muted">此版本保存的是原稿，初始整理尚未完成。</p>
          <button
            v-if="
              state.companion.currentPersonaVersion.document &&
              selection === 'current' &&
              !editingLocks
            "
            class="button button--quiet"
            @click="editLocks"
          >
            管理长期约束
          </button>
          <form v-if="editingLocks" class="companion-detail__locks" @submit.prevent="saveLocks">
            <label for="edit-locks">长期保留的约束</label>
            <textarea
              id="edit-locks"
              v-model="locksText"
              class="persona-page__input"
              rows="5"
              :disabled="saving"
              aria-describedby="locks-help"
            />
            <p id="locks-help" class="persona-page__muted">
              每行一条，最多 40 条，每条 800 字。清空并保存表示解除这些明确约束。初始人格仍会保留。
            </p>
            <div class="persona-page__toolbar">
              <button class="button button--primary" :disabled="saving" type="submit">
                保存约束</button
              ><button
                class="button button--quiet"
                :disabled="saving"
                type="button"
                @click="closeLocks"
              >
                取消编辑
              </button>
            </div>
          </form>
        </section>
        <section class="persona-page__panel">
          <h2>最初的人设原稿</h2>
          <p class="persona-page__muted">这是创建时的设定，不是伴侣实际经历过的对话或事件。</p>
          <p class="persona-page__text">{{ state.companion.initialSnapshot.profileText }}</p>
          <p v-if="state.template" class="persona-page__muted">
            来自人设模板的第 {{ state.template.version }} 版，后续模板更新不会覆盖此处。
          </p>
        </section>
        <section class="persona-page__panel" aria-label="实例管理">
          <h2>实例管理</h2>
          <p class="persona-page__muted">
            重置会保留初始人生并清除私有成长；删除会移除整个实例。已发布的共同原文仍保留，若需删除原文，请在聊天中单独选择。
          </p>
          <RouterLink
            v-if="state.companion.lifecycleOperationId"
            :to="`/lifecycle/${state.companion.lifecycleOperationId}`"
            >查看正在进行的清理</RouterLink
          >
          <div v-else class="persona-page__toolbar">
            <button class="button button--secondary" :disabled="saving" @click="resetCompanion">
              重置伴侣
            </button>
            <button class="button button--quiet" :disabled="saving" @click="deleteCompanion">
              删除伴侣
            </button>
          </div>
        </section>
      </template>
      <button v-else-if="!loading" class="button button--secondary" @click="refresh">
        重新读取伴侣
      </button>
    </div>
  </CompanionLayout>
</template>

<script setup lang="ts">
import { createLifecycle } from '@/services/lifecycle';
import { createChat } from '@/services/chats';
import { computed, onScopeDispose, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { revisePersonaLocksSchema } from '@memory-weave/contracts';
import type { CompanionPersonaState, PersonaVersion } from '@memory-weave/contracts';
import CompanionLayout from '@/components/CompanionLayout.vue';
import PersonaDocumentView from '@/components/PersonaDocumentView.vue';
import { usePersonaPage } from '@/composables/usePersonaPage';
import { useCommandIdentity } from '@/composables/useCommandIdentity';
import {
  getPersona,
  getPersonaVersion,
  reviseLocks,
  initializePersona,
  controlPersonaTask,
} from '@/services/personas';
const route = useRoute();
const { loading, saving, error, run } = usePersonaPage();
const identifyLocks = useCommandIdentity();
const identifyInitialization = useCommandIdentity();
const identifyChat = useCommandIdentity();
const identifyLifecycle = useCommandIdentity();
const state = ref<CompanionPersonaState | null>(null);
const selection = ref<'current' | 'initial' | 'history'>('current');
const history = ref<PersonaVersion | null>(null);
const historyNumber = ref(1);
const editingLocks = ref(false);
const locksText = ref('');
const editingVersion = ref(0);
const displayed = computed(() =>
  selection.value === 'initial'
    ? state.value?.initialPersonaVersion
    : selection.value === 'history'
      ? history.value
      : state.value?.companion.currentPersonaVersion,
);
const versionLabel = computed(
  () =>
    `${selection.value === 'initial' ? '初始人格' : selection.value === 'history' ? '历史人格' : '当前人格'} · 第 ${displayed.value?.version ?? 1} 版`,
);
const canPause = computed(() =>
  Boolean(state.value?.task && ['queued', 'running', 'waiting'].includes(state.value.task.status)),
);
const canCancel = computed(() =>
  Boolean(
    state.value?.task &&
    ['queued', 'running', 'waiting', 'paused', 'blocked'].includes(state.value.task.status),
  ),
);
const canInitialize = computed(() =>
  Boolean(
    state.value &&
    !state.value.companion.currentPersonaVersion.document &&
    (!state.value.task || ['failed', 'cancelled'].includes(state.value.task.status)),
  ),
);
const statusLabel = computed(() =>
  state.value?.initialPersonaVersion
    ? '初始人格已整理'
    : {
        queued: '等待整理初始人格',
        running: '正在整理初始人格',
        waiting: '稍后继续整理',
        paused: '整理已暂停',
        blocked: '整理需要核对',
        failed: '本次整理未完成',
        cancelled: '整理已取消',
        succeeded: '初始人格已整理',
      }[state.value?.task?.status ?? 'queued'],
);
const statusHint = computed(() => {
  if (!state.value?.task) return '原稿已保存，点击开始后会按当前模型配置整理。';
  if (state.value.task.reason === 'model_result_unknown')
    return '模型调用结果尚不明确，已停止重复发送。请先核对调用记录，原稿仍在。';
  if (state.value.task.status === 'failed')
    return '原稿完整保留。请检查当前模型能力、额度或输出情况，再主动重新尝试。';
  return state.value.initialPersonaVersion
    ? '无需逐项确认。后续成长会使用独立版本，始终保留这个起点。'
    : '可以离开或刷新页面，后台进度会保存。';
});
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
watch(() => route.params.id, changeCompanion, { immediate: true });
onScopeDispose(() => {
  disposed = true;
  clearTimeout(timer);
});
/** 切换实例时不沿用上一实例的显示与编辑状态。 */
async function changeCompanion(): Promise<void> {
  if (route.name !== 'companion-detail' || typeof route.params.id !== 'string') return;
  state.value = null;
  selection.value = 'current';
  editingLocks.value = false;
  history.value = null;
  await refresh();
}
/** 只轮询尚在运行的整理，离开页面停止读取。 */
async function refresh(): Promise<void> {
  clearTimeout(timer);
  const result = await run(() => getPersona(String(route.params.id)));
  if (result) state.value = result;
  if (
    !disposed &&
    !error.value &&
    state.value?.task &&
    ['queued', 'running', 'waiting'].includes(state.value.task.status)
  )
    timer = setTimeout(refresh, 1500);
}
/** 选择当前人格并关闭未提交编辑。 */
function showCurrent(): void {
  selection.value = 'current';
  editingLocks.value = false;
}
/** 选择固定的初始人格，不覆盖当前版本。 */
function showInitial(): void {
  selection.value = 'initial';
  editingLocks.value = false;
}
/** 明确输入版本后读取，不一次下载所有历史。 */
async function loadHistory(): Promise<void> {
  if (!state.value || !Number.isInteger(historyNumber.value) || historyNumber.value < 1) {
    error.value = '请输入有效版本号。';
    return;
  }
  const result = await run(() =>
    getPersonaVersion(
      state.value!.companion.id,
      state.value!.companion.runtimeEpoch,
      historyNumber.value,
    ),
  );
  if (result) {
    history.value = result;
    selection.value = 'history';
    editingLocks.value = false;
  }
}
/** 编辑采用当前版本，防止后台刷新后无意覆盖他人的修订。 */
function editLocks(): void {
  if (!state.value) return;
  locksText.value =
    state.value.companion.currentPersonaVersion.document?.locks
      .map((lock) => lock.text)
      .join('\n') ?? '';
  editingVersion.value = state.value.companion.currentPersonaVersion.version;
  editingLocks.value = true;
}
/** 丢弃本地编辑，不修改已保存约束。 */
function closeLocks(): void {
  editingLocks.value = false;
}
/** 每次明确保存追加版本，同载荷重试沿用命令身份。 */
async function saveLocks(): Promise<void> {
  if (!state.value) return;
  const value = {
    runtimeEpoch: state.value.companion.runtimeEpoch,
    expectedPersonaVersion: editingVersion.value,
    lockedFeatures: locksText.value
      .split('\n')
      .map((text) => text.trim())
      .filter(Boolean),
  };
  const parsed = revisePersonaLocksSchema.safeParse({ ...value, requestId: identifyLocks(value) });
  if (!parsed.success) {
    error.value = '约束最多 40 条，每条最多 800 字。';
    return;
  }
  const result = await run(() => reviseLocks(state.value!.companion.id, parsed.data), true);
  if (result) {
    editingLocks.value = false;
    selection.value = 'current';
    await refresh();
  }
}
/** 只有显式操作才为旧原稿或已知失败创建新任务。 */
async function initialize(): Promise<void> {
  if (!state.value) return;
  const value = {
    runtimeEpoch: state.value.companion.runtimeEpoch,
    expectedPersonaVersion: state.value.companion.currentPersonaVersion.version,
    previousTaskId: state.value.task?.id,
  };
  const result = await run(
    () =>
      initializePersona(state.value!.companion.id, {
        requestId: identifyInitialization(value),
        runtimeEpoch: value.runtimeEpoch,
        expectedPersonaVersion: value.expectedPersonaVersion,
      }),
    true,
  );
  if (result) {
    state.value = result;
    await refresh();
  }
}
/** 管理操作由服务端确认，页面不乐观伪造状态。 */
async function control(action: 'pause' | 'resume' | 'cancel'): Promise<void> {
  if (!state.value?.task) return;
  const result = await run(() => controlPersonaTask(state.value!.task!.id, action), true);
  if (result) await refresh();
}
async function pause(): Promise<void> {
  await control('pause');
}
async function resume(): Promise<void> {
  await control('resume');
}
async function cancel(): Promise<void> {
  await control('cancel');
}
const chatRouter = useRouter();
/** 点击才创建新私聊；网络重试保留同一身份，普通查看伴侣不触发模型。 */
async function startChat(): Promise<void> {
  if (!state.value || state.value.companion.lifecycleOperationId) return;
  const companion = state.value.companion;
  const chat = await run(
    () =>
      createChat({
        requestId: identifyChat({
          companionId: companion.id,
          runtimeEpoch: companion.runtimeEpoch,
        }),
        companionId: companion.id,
        runtimeEpoch: companion.runtimeEpoch,
        title: `${companion.name.slice(0, 72)}的私聊`,
      }),
    true,
  );
  if (chat) await chatRouter.push({ name: 'chat', params: { id: chat.id } });
}
/** 确认目标与影响后提交已看到的实例版本；不自动扩大到其他实例。 */
async function manageCompanion(kind: 'reset_companion' | 'delete_companion'): Promise<void> {
  const companion = state.value?.companion;
  if (!companion || saving.value || companion.lifecycleOperationId) return;
  const action = kind === 'reset_companion' ? '重置' : '删除';
  const scope =
    kind === 'reset_companion'
      ? '清除私有成长，保留初始人生，并从新会话开始。'
      : '移除该实例及其私有人格。';
  if (
    !window.confirm(
      `确定${action}“${companion.name}”吗？${scope}已发布的共同原文会保留。此操作不能撤销。`,
    )
  )
    return;
  const value = {
    kind,
    companionId: companion.id,
    runtimeEpoch: companion.runtimeEpoch,
    expectedVersion: companion.version,
  };
  const result = await run(
    () => createLifecycle({ ...value, requestId: identifyLifecycle(value) }),
    true,
  );
  if (result) await chatRouter.push({ name: 'lifecycle', params: { id: result.id } });
}
/** 重置当前实例，沿用创建时的初始人生。 */
async function resetCompanion(): Promise<void> {
  await manageCompanion('reset_companion');
}
/** 删除当前实例，保留共同原文的最小历史身份。 */
async function deleteCompanion(): Promise<void> {
  await manageCompanion('delete_companion');
}
</script>

<style scoped lang="scss">
.companion-detail {
  &__version {
    width: 90px;
  }
  &__locks {
    display: grid;
    gap: var(--space-3);
  }
}
</style>
