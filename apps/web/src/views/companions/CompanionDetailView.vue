<template>
  <ChatLayout ref="layout">
    <div class="persona-page companion-profile">
      <RouterLink class="companion-profile__back" to="/companions">← 所有伴侣</RouterLink>
      <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
      <p v-if="loading && !state" role="status">正在读取伴侣…</p>
      <template v-if="state">
        <header class="persona-page__intro companion-profile__intro">
          <CompanionAvatar
            :name="state.companion.name"
            :avatar="state.companion.avatar"
            :size="84"
          />
          <p class="eyebrow">每段故事，都有一个起点</p>
          <h1 class="persona-page__title">{{ state.companion.name }}</h1>
          <button
            class="button button--primary"
            :disabled="saving || !!state.companion.lifecycleOperationId"
            @click="startChat"
          >
            开始聊天
          </button>
        </header>
        <AvatarEditor
          :key="state.companion.id"
          :companion="state.companion"
          @changed="updateAvatar"
          @refresh="refresh"
        />
        <p v-if="state.companion.currentPersonaVersion.mode === 'test'" class="persona-page__badge">
          测试模式：当前人设用于验证保存流程。
        </p>
        <p v-if="state.companion.lifecycleOperationId" class="notice" role="status">
          正在整理这段人生，稍后再来看看。
        </p>
        <section
          v-if="state.companion.currentPersonaVersion.document"
          class="persona-page__panel"
          aria-label="伴侣资料"
        >
          <h2>关于 {{ state.companion.name }}</h2>
          <PersonaDocumentView :document="state.companion.currentPersonaVersion.document" />
        </section>
        <p v-else class="persona-page__muted" role="status">{{ waitingHint }}</p>
        <section class="persona-page__panel">
          <h2>故事的起点</h2>
          <p class="persona-page__muted">创建时写下的人生设定，将一直保留。</p>
          <p class="persona-page__text">{{ state.companion.initialSnapshot.profileText }}</p>
        </section>
      </template>
      <button v-else-if="!loading" class="button button--secondary" @click="refresh">
        重新读取伴侣
      </button>
    </div>
  </ChatLayout>
</template>
<script setup lang="ts">
import CompanionAvatar from '@/components/CompanionAvatar.vue';
import AvatarEditor from '@/components/AvatarEditor.vue';
import type { AvatarState } from '@memory-weave/contracts';
import { computed, onScopeDispose, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import type { CompanionPersonaState } from '@memory-weave/contracts';
import { getPersona } from '@memory-weave/browser-client/personas';
import { createChat } from '@memory-weave/browser-client/chats';
import ChatLayout from '@/components/ChatLayout.vue';
import PersonaDocumentView from '@/components/PersonaDocumentView.vue';
import { usePersonaPage } from '@/composables/usePersonaPage';
import { useCommandIdentity } from '@/composables/useCommandIdentity';
const layout = ref<InstanceType<typeof ChatLayout> | null>(null);
const route = useRoute();
const router = useRouter();
const { loading, saving, error, run } = usePersonaPage();
const identifyChat = useCommandIdentity();
const state = ref<CompanionPersonaState | null>(null);
const waitingHint = computed(() =>
  state.value?.task && ['queued', 'running', 'waiting'].includes(state.value.task.status)
    ? '正在整理最初的人生，可以稍后回来看看。'
    : '原稿已经保存。初始整理尚未完成，可在管理端查看进度。',
);
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let generation = 0;
watch(
  () => route.params.id,
  () => {
    generation++;
    state.value = null;
    void refresh();
  },
  { immediate: true },
);
onScopeDispose(() => {
  disposed = true;
  generation++;
  clearTimeout(timer);
});
/** 仅等待初始资料时轮询，路由切换后丢弃旧响应。 */
async function refresh(): Promise<void> {
  clearTimeout(timer);
  const token = generation;
  const result = await run(() => getPersona(String(route.params.id)));
  if (disposed || token !== generation) return;
  if (result) {
    const current = state.value?.companion;
    if (
      current?.id === result.companion.id &&
      current.avatarVersion > result.companion.avatarVersion
    )
      result.companion = {
        ...result.companion,
        avatar: current.avatar,
        avatarVersion: current.avatarVersion,
      };
    state.value = result;
  }
  if (
    !error.value &&
    state.value?.task &&
    ['queued', 'running', 'waiting'].includes(state.value.task.status)
  )
    timer = setTimeout(refresh, 1500);
}
/** 明确点击才开始私聊，同一操作的网络重试使用相同身份。 */
async function startChat(): Promise<void> {
  const companion = state.value?.companion;
  if (!companion || companion.lifecycleOperationId) return;
  const token = generation;
  const value = { companionId: companion.id, runtimeEpoch: companion.runtimeEpoch };
  const chat = await run(
    () =>
      createChat({
        ...value,
        requestId: identifyChat(value),
        title: `${companion.name.slice(0, 72)}的私聊`,
      }),
    true,
  );
  if (chat && token === generation) await router.push({ name: 'chat', params: { id: chat.id } });
}
/** 只更新展示资料，正在生成的人格内容保持自己的版本。 */
function updateAvatar(value: AvatarState): void {
  void layout.value?.refreshChats();
  if (state.value)
    state.value = { ...state.value, companion: { ...state.value.companion, ...value } };
}
</script>
<style scoped lang="scss">
.companion-profile {
  max-width: 760px;
  margin: 0 auto;
}
.companion-profile__back {
  font-size: 13px;
  color: var(--color-ink-soft);
  text-decoration: none;
}
.companion-profile__intro {
  text-align: center;
  padding: 24px 0;
  justify-items: center;
}
</style>
