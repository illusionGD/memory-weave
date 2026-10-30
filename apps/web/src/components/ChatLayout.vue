<template>
  <div class="chat-shell" :class="{ 'chat-shell--conversation': route.name === 'chat' }">
    <aside class="chat-shell__sidebar">
      <RouterLink class="chat-shell__brand" to="/chats"><BrandMark /></RouterLink>
      <p class="chat-shell__caption">让相遇，有迹可循</p>
      <nav class="chat-shell__nav" aria-label="个人空间">
        <RouterLink to="/chats" :class="{ 'is-active': route.path.startsWith('/chats') }"
          ><span aria-hidden="true">◌</span>私聊</RouterLink
        >
        <RouterLink to="/companions" :class="{ 'is-active': route.path.startsWith('/companions') }"
          ><span aria-hidden="true">✳</span>伴侣</RouterLink
        >
        <RouterLink to="/settings"><span aria-hidden="true">⌁</span>个人设置</RouterLink>
      </nav>
      <div class="chat-shell__quiet" aria-hidden="true">
        <span></span>
        <p>日子缓缓，<br />故事慢慢生长。</p>
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
import { RouterLink, useRoute, useRouter } from 'vue-router';
import BrandMark from './BrandMark.vue';
import { useAuthStore } from '@/stores/auth';
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
/** 服务端确认退出后再离开私人页面。 */
async function logout(): Promise<void> {
  if (await auth.signOut()) await router.replace({ name: 'login' });
}
</script>
<style scoped lang="scss">
.chat-shell {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  min-height: 100svh;
}
.chat-shell__sidebar {
  position: sticky;
  top: 0;
  height: 100svh;
  padding: 36px 24px 22px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid #e3e7de;
  background: #f0f1e9;
}
.chat-shell__brand {
  text-decoration: none;
}
.chat-shell__brand :deep(.brand) {
  gap: 8px;
}
.chat-shell__brand :deep(.brand__name) {
  font-size: 19px;
}
.chat-shell__brand :deep(.brand__symbol) {
  width: 28px;
  height: 28px;
}
.chat-shell__caption {
  color: #879083;
  font-size: 11px;
  letter-spacing: 3px;
  margin: 12px 0 42px;
}
.chat-shell__nav {
  display: grid;
  gap: 10px;
}
.chat-shell__nav a {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 11px 16px;
  border-radius: 12px;
  color: #6b776c;
  text-decoration: none;
  font-size: 14px;
  transition: background 0.2s;
}
.chat-shell__nav a:hover {
  background: #e5eadd;
}
.chat-shell__nav .is-active,
.chat-shell__nav .router-link-exact-active {
  background: #e1e8d9;
  color: #365944;
}
.chat-shell__nav span {
  font-size: 22px;
  width: 22px;
  line-height: 1;
}
.chat-shell__quiet {
  margin-top: auto;
  padding: 70px 14px 40px;
  color: #8a9688;
  font: 14px/2.2 var(--font-display);
  letter-spacing: 3px;
}
.chat-shell__quiet span {
  display: block;
  width: 52px;
  height: 72px;
  margin-bottom: 26px;
  border: 1px solid #bdcbb6;
  border-radius: 90% 0 90% 0;
  transform: rotate(-15deg);
}
.chat-shell__logout {
  align-self: flex-start;
  font-size: 12px;
  color: #7d877a;
}
.chat-shell__main {
  min-width: 0;
  background: radial-gradient(ellipse at 90% 0%, #eef2e780, transparent 50%), var(--color-canvas);
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
  color: #8b9586;
}
.chat-shell__content {
  max-width: 1150px;
  margin: 0 auto;
  padding: 40px 48px 64px;
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
  .chat-shell__quiet {
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
}

.chat-shell--conversation {
  height: 100svh;
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
  padding: 28px 40px 20px;
}
@media (max-width: 800px) {
  .chat-shell--conversation {
    grid-template-rows: auto minmax(0, 1fr);
  }
  .chat-shell--conversation .chat-shell__content {
    padding: 16px 18px;
  }
}
@media (max-height: 600px) {
  .chat-shell--conversation {
    height: auto;
    min-height: 100svh;
    overflow: visible;
  }
}
</style>
