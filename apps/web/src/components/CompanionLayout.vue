<template>
  <main class="companion-layout">
    <header class="companion-layout__header">
      <BrandMark />
      <nav class="companion-layout__nav" aria-label="个人空间">
        <RouterLink class="button button--quiet" to="/companions">伴侣</RouterLink>
        <RouterLink class="button button--quiet" to="/persona-templates">人设模板</RouterLink>
        <RouterLink class="button button--quiet" to="/">运行状态</RouterLink>
        <button
          class="button button--quiet"
          type="button"
          :disabled="auth.loggingOut"
          @click="logout"
        >
          {{ auth.loggingOut ? '正在退出…' : '退出登录' }}
        </button>
      </nav>
    </header>
    <div class="companion-layout__content">
      <p v-if="auth.error" class="notice notice--error" role="alert">{{ auth.error }}</p>
      <slot />
    </div>
    <footer class="companion-layout__footer">Memory Weave · 私人部署</footer>
  </main>
</template>

<script setup lang="ts">
import { RouterLink, useRouter } from 'vue-router';
import BrandMark from './BrandMark.vue';
import { useAuthStore } from '@/stores/auth';
const auth = useAuthStore();
const router = useRouter();
/** 服务端确认撤销会话后再离开私人页面。 */
async function logout(): Promise<void> {
  if (await auth.signOut()) await router.replace({ name: 'login' });
}
</script>

<style scoped lang="scss">
.companion-layout {
  min-height: 100vh;
  &__header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-5) max(var(--space-5), calc((100vw - 1200px) / 2));
    border-bottom: 1px solid var(--color-border);
  }
  &__nav {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }
  &__content {
    width: min(100% - var(--space-10), 1060px);
    margin: var(--space-12) auto;
  }
  &__footer {
    padding: var(--space-8);
    text-align: center;
    color: var(--color-ink-soft);
    font-size: 0.8rem;
  }
}
</style>
