<template>
  <div class="chat-shell" :class="{ 'chat-shell--conversation': route.name === 'chat' }">
    <aside class="chat-shell__sidebar">
      <RouterLink class="chat-shell__brand" to="/chats"><BrandMark /></RouterLink>
      <p class="chat-shell__caption">把相遇，织成星河</p>
      <nav class="chat-shell__nav" aria-label="个人空间">
        <RouterLink to="/chats" :class="{ 'is-active': route.path.startsWith('/chats') }"
          ><span aria-hidden="true">◌</span>私聊</RouterLink
        >
        <RouterLink to="/companions" :class="{ 'is-active': route.path.startsWith('/companions') }"
          ><span aria-hidden="true">✧</span>伴侣</RouterLink
        >
        <RouterLink to="/settings"><span aria-hidden="true">☷</span>个人设置</RouterLink>
      </nav>
      <section class="chat-shell__threads" aria-label="你的对话">
        <h2>你的对话</h2>
        <p v-if="threadError" class="chat-shell__hint">
          暂时无法读取。<button @click="refreshChats">重试</button>
        </p>
        <p v-else-if="!threads.length" class="chat-shell__hint">故事，从一句问候开始。</p>
        <RouterLink
          v-for="thread in threads"
          :key="thread.id"
          :to="`/chats/${thread.id}`"
          class="chat-shell__thread"
        >
          <CompanionAvatar
            :avatar="thread.avatar"
            :name="thread.companionName ?? thread.title"
            :size="36"
          />
          <span
            ><strong>{{ thread.companionName ?? thread.title }}</strong
            ><small>{{ thread.title }}</small></span
          >
        </RouterLink>
        <RouterLink v-if="threads.length" class="chat-shell__all" to="/chats"
          >查看全部对话 →</RouterLink
        >
      </section>
      <div class="chat-shell__quiet" aria-hidden="true">
        <svg viewBox="0 0 80 60" fill="none">
          <path
            d="m10 43 19-28 30 12 12-18M29 15l9 34 21-22"
            stroke="currentColor"
            stroke-width=".6"
          />
          <g fill="currentColor">
            <circle cx="10" cy="43" r="1.4" />
            <circle cx="29" cy="15" r="2" />
            <circle cx="59" cy="27" r="1.4" />
            <circle cx="71" cy="9" r="1.5" />
            <circle cx="38" cy="49" r="1" />
          </g>
        </svg>
        <p>星光很慢，故事很长。</p>
      </div>
      <button
        class="button button--quiet chat-shell__logout"
        :disabled="auth.loggingOut"
        @click="logout"
      >
        {{ auth.loggingOut ? '正在退出…' : '退出登录' }}
      </button>
    </aside>
    <main class="chat-shell__main">
      <div class="chat-shell__topline"><span>MEMORY WEAVE</span><span>属于你们的片刻</span></div>
      <div class="chat-shell__content">
        <p v-if="auth.error" class="notice notice--error" role="alert">{{ auth.error }}</p>
        <slot />
      </div>
    </main>
  </div>
</template>
<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import type { Chat } from '@memory-weave/contracts';
import { listChats } from '@memory-weave/browser-client/chats';
import BrandMark from './BrandMark.vue';
import CompanionAvatar from './CompanionAvatar.vue';
import { useAuthStore } from '@/stores/auth';
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const threads = ref<Chat[]>([]);
const threadError = ref(false);
let disposed = false;
let loading = false;
onMounted(() => {
  void refreshChats();
  window.addEventListener('focus', refreshChats);
});
onScopeDispose(() => {
  disposed = true;
  window.removeEventListener('focus', refreshChats);
});
defineExpose({ refreshChats });
/** 有界读取对话入口，不把稳定 UUID 分页误称为最近消息排序。 */
async function refreshChats(): Promise<void> {
  if (loading || disposed) return;
  loading = true;
  try {
    const result = await listChats();
    if (!disposed) {
      threads.value = result.items.slice(0, 5);
      threadError.value = false;
    }
  } catch {
    if (!disposed) threadError.value = true;
  } finally {
    loading = false;
  }
}
/** 服务端确认退出后再离开私人页面。 */
async function logout(): Promise<void> {
  if (await auth.signOut()) await router.replace({ name: 'login' });
}
</script>
<style scoped lang="scss">
.chat-shell {
  display: grid;
  grid-template-columns: 246px minmax(0, 1fr);
  min-height: 100svh;
}
.chat-shell__sidebar {
  position: sticky;
  top: 0;
  height: 100svh;
  padding: 36px 22px 20px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--color-border);
  background: var(--color-sidebar);
  overflow-y: auto;
}
.chat-shell__brand {
  text-decoration: none;
}
.chat-shell__brand :deep(.brand) {
  gap: 8px;
}
.chat-shell__brand :deep(.brand__name) {
  font-size: 20px;
}
.chat-shell__brand :deep(.brand__symbol) {
  width: 25px;
  height: 25px;
}
.chat-shell__caption {
  color: var(--color-ink-soft);
  font-size: 11px;
  letter-spacing: 3px;
  margin: 12px 0 38px 5px;
}
.chat-shell__nav {
  display: grid;
  gap: 8px;
}
.chat-shell__nav a {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 11px 16px;
  border-radius: 10px;
  color: var(--color-ink-soft);
  text-decoration: none;
  font-size: 14px;
}
.chat-shell__nav a:hover {
  background: var(--color-surface-muted);
}
.chat-shell__nav .is-active,
.chat-shell__nav .router-link-exact-active {
  background: var(--color-accent-soft);
  color: var(--color-ink);
}
.chat-shell__nav span {
  font-size: 22px;
  width: 22px;
  line-height: 1;
}
.chat-shell__threads {
  margin-top: 40px;
}
.chat-shell__threads h2 {
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 2px;
  color: var(--color-ink-soft);
  padding: 0 12px 12px;
}
.chat-shell__thread {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 10px;
  text-decoration: none;
  color: var(--color-ink);
  border-radius: 10px;
}
.chat-shell__thread:hover,
.chat-shell__thread.router-link-exact-active {
  background: var(--color-surface-muted);
}
.chat-shell__thread span {
  min-width: 0;
}
.chat-shell__thread strong,
.chat-shell__thread small {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.chat-shell__thread strong {
  font-size: 13px;
  font-weight: 400;
}
.chat-shell__thread small {
  color: var(--color-ink-soft);
  font-size: 10px;
  margin-top: 4px;
}
.chat-shell__hint,
.chat-shell__all {
  color: var(--color-ink-soft);
  font-size: 11px;
  padding: 12px;
}
.chat-shell__hint button {
  color: var(--color-accent);
  background: none;
  border: 0;
}
.chat-shell__all {
  display: inline-block;
  text-decoration: none;
}
.chat-shell__quiet {
  margin-top: auto;
  padding: 28px 12px 22px;
  color: #939ab9;
  font: 12px/2.2 var(--font-display);
  letter-spacing: 2px;
}
.chat-shell__quiet svg {
  display: block;
  width: 66px;
  height: 50px;
  margin-bottom: 12px;
  opacity: 0.55;
}
.chat-shell__logout {
  align-self: flex-start;
  font-size: 12px;
}
.chat-shell__main {
  position: relative;
  isolation: isolate;
  min-width: 0;
  background: radial-gradient(ellipse at 92% 90%, #2b244733, transparent 55%), var(--color-canvas);
}
.chat-shell__main::before {
  content: '';
  position: absolute;
  z-index: -1;
  inset: 0;
  pointer-events: none;
  opacity: 0.35;
  background:
    radial-gradient(circle at 95% 19%, #bbb3da 0 1px, transparent 1.5px),
    radial-gradient(circle at 89% 45%, #bbb3da 0 0.7px, transparent 1.3px),
    radial-gradient(circle at 96% 70%, #bbb3da 0 1px, transparent 1.5px),
    radial-gradient(circle at 4% 31%, #bbb3da 0 0.7px, transparent 1.3px),
    radial-gradient(circle at 6% 83%, #bbb3da 0 1px, transparent 1.5px);
}
.chat-shell__topline {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin: 0 48px;
  padding: 26px 0;
  border-bottom: 1px solid var(--color-border);
  font-size: 10px;
  letter-spacing: 2px;
  color: var(--color-ink-soft);
}
.chat-shell__content {
  max-width: 1150px;
  margin: 0 auto;
  padding: 40px 48px 64px;
}
.chat-shell--conversation {
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}
.chat-shell--conversation .chat-shell__main {
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.chat-shell--conversation .chat-shell__topline {
  display: none;
}
.chat-shell--conversation .chat-shell__content {
  flex: 1;
  min-height: 0;
  width: 100%;
  padding: 28px 40px 24px;
}
@media (max-width: 800px) {
  .chat-shell {
    grid-template-columns: 1fr;
  }
  .chat-shell__sidebar {
    position: static;
    height: auto;
    padding: 16px 20px 10px;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 14px;
  }
  .chat-shell__caption,
  .chat-shell__quiet,
  .chat-shell__threads {
    display: none;
  }
  .chat-shell__nav {
    grid-column: 1 / -1;
    grid-row: 2;
    display: flex;
    gap: 8px;
  }
  .chat-shell__nav a {
    padding: 7px 12px;
    font-size: 13px;
  }
  .chat-shell__nav span {
    font-size: 18px;
    width: 16px;
  }
  .chat-shell__logout {
    grid-column: 2;
    grid-row: 1;
    padding: 4px;
    min-height: 32px;
  }
  .chat-shell__topline {
    margin: 0 22px;
    padding: 18px 0;
    font-size: 9px;
  }
  .chat-shell__content {
    padding: 28px 22px 40px;
  }
  .chat-shell--conversation .chat-shell__sidebar {
    display: none;
  }
  .chat-shell--conversation .chat-shell__content {
    padding: 16px 18px max(18px, env(safe-area-inset-bottom));
  }
}
</style>
