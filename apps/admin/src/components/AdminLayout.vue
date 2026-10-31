<template>
  <div class="admin-shell">
    <aside class="admin-shell__sidebar" aria-label="后台导航">
      <RouterLink class="admin-shell__brand" to="/"
        ><BrandMark /><span>管理控制台</span></RouterLink
      >
      <p class="admin-shell__group">工作空间</p>
      <nav class="admin-shell__nav" aria-label="后台管理">
        <RouterLink
          v-for="item in navigation"
          :key="item.to"
          :to="item.to"
          :class="{ 'is-active': isActive(item.to) }"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            aria-hidden="true"
          >
            <path :d="item.icon" />
          </svg>
          {{ item.label }}
        </RouterLink>
      </nav>
      <div class="admin-shell__bottom">
        <span class="admin-shell__indicator"></span>私人部署<span>CONTROL CENTER</span>
      </div>
    </aside>
    <div class="admin-shell__main">
      <header class="admin-shell__header">
        <div class="admin-shell__breadcrumb">
          <span>控制台</span><span aria-hidden="true">/</span
          ><strong>{{ route.meta.title ?? '管理' }}</strong>
        </div>
        <div class="admin-shell__actions">
          <a :href="chatUrl()" target="_blank" rel="noopener">打开聊天端 ↗</a
          ><button class="button button--quiet" :disabled="auth.loggingOut" @click="logout">
            退出登录
          </button>
        </div>
      </header>
      <main class="admin-shell__content">
        <p v-if="auth.error" class="notice notice--error" role="alert">{{ auth.error }}</p>
        <slot />
      </main>
      <footer class="admin-shell__footer">Memory Weave <span>管理工作空间</span></footer>
    </div>
  </div>
</template>
<script setup lang="ts">
import { RouterLink, useRoute, useRouter } from 'vue-router';
import BrandMark from './BrandMark.vue';
import { useAuthStore } from '@/stores/auth';
import { chatUrl } from '@/utils/chat-url';
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const navigation = [
  { to: '/', label: '运行概览', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z' },
  {
    to: '/companions',
    label: '伴侣管理',
    icon: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3a4 4 0 0 1 0 8',
  },
  { to: '/persona-templates', label: '人设模板', icon: 'M5 3h14v18H5zM8 7h8M8 11h8M8 15h5' },
  {
    to: '/memories',
    label: '记忆记录',
    icon: 'M4 4h6a3 3 0 0 1 3 3v14a3 3 0 0 0-3-3H4zM13 7a3 3 0 0 1 3-3h5v14h-5a3 3 0 0 0-3 3',
  },
  {
    to: '/lifecycle',
    label: '清理记录',
    icon: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6',
  },
];
/** 详情沿用所属管理分区，避免把首页同时标为选中。 */
function isActive(path: string): boolean {
  return path === '/'
    ? route.path === '/'
    : path === '/memories'
      ? route.name === 'memories' || route.name === 'memory-explorer' || route.path === '/memories'
      : route.path.startsWith(path) &&
        !(
          path === '/companions' &&
          (route.name === 'memories' || route.name === 'memory-explorer')
        );
}
/** 服务端撤销成功后清空当前管理会话。 */
async function logout(): Promise<void> {
  if (await auth.signOut()) await router.replace({ name: 'login' });
}
</script>
<style scoped lang="scss">
.admin-shell {
  min-height: 100svh;
  display: grid;
  grid-template-columns: 228px minmax(0, 1fr);
}
.admin-shell__sidebar {
  position: sticky;
  top: 0;
  height: 100svh;
  background: #172339;
  color: #b0bfd4;
  padding: 30px 16px 22px;
  display: flex;
  flex-direction: column;
}
.admin-shell__brand {
  display: grid;
  gap: 10px;
  padding: 0 12px 32px;
  color: #f3f6fc;
  text-decoration: none;
  font-size: 11px;
  letter-spacing: 2px;
}
.admin-shell__brand :deep(.brand) {
  gap: 8px;
}
.admin-shell__brand :deep(.brand__name) {
  color: #f3f6fc;
  font-size: 18px;
  letter-spacing: -0.4px;
}
.admin-shell__brand :deep(.brand__symbol) {
  width: 28px;
  height: 28px;
}
.admin-shell__brand :deep(svg) {
  color: #94b8ff;
}
.admin-shell__group {
  padding: 0 14px;
  margin-bottom: 12px;
  font-size: 11px;
  letter-spacing: 2px;
  color: #7e92b0;
}
.admin-shell__nav {
  display: grid;
  gap: 6px;
}
.admin-shell__nav a {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 6px;
  text-decoration: none;
  color: inherit;
  font-size: 13px;
  transition: background 0.18s;
}
.admin-shell__nav a:hover {
  background: #24324c;
}
.admin-shell__nav a.is-active {
  background: #2b4677;
  color: #fff;
}
.admin-shell__nav a svg {
  width: 18px;
  height: 18px;
  flex: none;
}
.admin-shell__bottom {
  margin-top: auto;
  padding: 22px 14px 0;
  border-top: 1px solid #2b374c;
  font-size: 12px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.admin-shell__bottom span:last-child {
  width: 100%;
  font-size: 9px;
  letter-spacing: 2px;
  color: #7386a4;
}
.admin-shell__indicator {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #7dd7ac;
  margin-top: 6px;
}
.admin-shell__main {
  min-width: 0;
}
.admin-shell__header {
  height: 72px;
  border-bottom: 1px solid var(--color-border);
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 36px;
  gap: 16px;
}
.admin-shell__breadcrumb,
.admin-shell__actions {
  display: flex;
  align-items: center;
  gap: 18px;
  font-size: 12px;
}
.admin-shell__breadcrumb {
  color: var(--color-ink-soft);
}
.admin-shell__breadcrumb strong {
  font-weight: 500;
  color: var(--color-ink);
}
.admin-shell__actions a {
  text-decoration: none;
}
.admin-shell__content {
  padding: 32px 36px;
  max-width: 1600px;
}
.admin-shell__footer {
  padding: 16px 36px;
  color: #8994a7;
  font-size: 11px;
  display: flex;
  justify-content: space-between;
}

@media (max-width: 850px) {
  .admin-shell {
    grid-template-columns: 1fr;
  }
  .admin-shell__sidebar {
    position: static;
    height: auto;
    padding: 14px 16px;
  }
  .admin-shell__brand {
    padding: 0 0 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .admin-shell__group,
  .admin-shell__bottom {
    display: none;
  }
  .admin-shell__nav {
    display: flex;
    overflow: auto;
    gap: 4px;
  }
  .admin-shell__nav a {
    white-space: nowrap;
    padding: 10px;
    font-size: 12px;
  }
  .admin-shell__nav a svg {
    display: none;
  }
  .admin-shell__header {
    height: 58px;
    padding: 0 20px;
  }
  .admin-shell__content {
    padding: 24px 20px;
  }
  .admin-shell__actions {
    gap: 6px;
  }
  .admin-shell__breadcrumb {
    gap: 8px;
  }
  .admin-shell__footer {
    padding: 16px 20px;
  }
}
</style>
