<template>
  <main class="workspace">
    <header class="workspace__header">
      <BrandMark />
      <button
        class="button button--quiet"
        type="button"
        :disabled="auth.loggingOut"
        :aria-busy="auth.loggingOut"
        @click="handleLogout"
      >
        {{ auth.loggingOut ? '正在退出…' : '退出登录' }}
      </button>
    </header>

    <div class="workspace__content">
      <section class="overview" aria-labelledby="status-title">
        <div>
          <p class="eyebrow">Your space, at a glance</p>
          <h1 id="status-title" class="overview__title">运行状态</h1>
          <p class="overview__description">查看这份私人空间是否已经准备就绪。</p>
        </div>
        <button
          class="button button--secondary"
          type="button"
          :disabled="system.loading || auth.loggingOut"
          :aria-busy="system.loading"
          @click="handleRefresh"
        >
          {{ system.loading ? '正在检查…' : '刷新状态' }}
        </button>
      </section>

      <p v-if="auth.error" class="notice notice--error" role="alert">{{ auth.error }}</p>
      <p v-if="system.error" class="notice notice--error" role="alert">{{ system.error }}</p>

      <section class="status-panel" :aria-busy="system.loading" aria-label="服务检查结果">
        <div class="status-panel__heading">
          <div class="status-panel__label">
            <span class="status-panel__dot" :class="statusClass" aria-hidden="true"></span>
            <h2 class="status-panel__title">{{ statusLabel }}</h2>
          </div>
          <span class="status-panel__time">{{ checkedAtLabel }}</span>
        </div>

        <div v-if="system.status" class="status-panel__grid">
          <article class="status-item">
            <span class="status-item__index" aria-hidden="true">01</span>
            <h3 class="status-item__title">后端服务</h3>
            <p class="status-item__value">运行中</p>
            <p class="status-item__detail">版本 {{ system.status.version }}</p>
          </article>

          <article class="status-item">
            <span class="status-item__index" aria-hidden="true">02</span>
            <h3 class="status-item__title">数据库</h3>
            <p class="status-item__value" :class="databaseClass">{{ databaseLabel }}</p>
            <p class="status-item__detail">{{ vectorLabel }}</p>
          </article>

          <article class="status-item">
            <span class="status-item__index" aria-hidden="true">03</span>
            <h3 class="status-item__title">附件目录</h3>
            <p class="status-item__value" :class="storageClass">{{ storageLabel }}</p>
            <p class="status-item__detail">{{ storageDetail }}</p>
          </article>
        </div>

        <p v-else class="status-panel__placeholder" role="status">{{ placeholderLabel }}</p>
      </section>

      <aside class="foundation-note" aria-label="当前版本范围">
        <span class="foundation-note__symbol" aria-hidden="true">✳</span>
        <div>
          <h2 class="foundation-note__title">空间的起点</h2>
          <p class="foundation-note__description">
            当前版本提供登录与运行检查。伴侣创建、聊天和记忆功能将逐步加入。
          </p>
        </div>
      </aside>
    </div>

    <footer class="workspace__footer">
      Memory Weave <span aria-hidden="true">·</span> 私人部署
    </footer>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import BrandMark from '@/components/BrandMark.vue';
import { useAuthStore } from '@/stores/auth';
import { useSystemStore } from '@/stores/system';

const auth = useAuthStore();
const system = useSystemStore();
const router = useRouter();

const databaseReady = computed(() => system.status?.database.status === 'connected');
const storageReady = computed(() => system.status?.storage.status === 'ready');
const allReady = computed(() => databaseReady.value && storageReady.value);
const statusLabel = computed(() => {
  if (system.loading) return '正在检查服务';
  if (!system.status) return '状态尚未确认';
  return allReady.value ? '服务已就绪' : '部分服务需要处理';
});
const statusClass = computed(() => ({
  'is-ready': Boolean(system.status) && allReady.value,
  'is-warning': Boolean(system.status) && !allReady.value,
}));
const checkedAtLabel = computed(() =>
  system.checkedAt
    ? `检查于 ${system.checkedAt.toLocaleTimeString('zh-CN', { hour12: false })}`
    : '等待检查结果',
);
const databaseLabel = computed(() => (databaseReady.value ? '已连接' : '暂不可用'));
const databaseClass = computed(() => ({ 'is-warning': !databaseReady.value }));
const vectorLabel = computed(() =>
  system.status?.database.vectorVersion
    ? `pgvector ${system.status.database.vectorVersion}`
    : '请检查数据库连接与向量扩展',
);
const storageLabel = computed(() => (storageReady.value ? '可读写' : '暂不可用'));
const storageClass = computed(() => ({ 'is-warning': !storageReady.value }));
const storageDetail = computed(() =>
  storageReady.value ? '持久目录已准备好' : '请检查目录权限与磁盘空间',
);
const placeholderLabel = computed(() =>
  system.loading ? '正在读取当前服务状态…' : '暂时没有可用的检查结果，请点击“刷新状态”重试。',
);

onMounted(handleRefresh);
onBeforeUnmount(system.reset);

/** 刷新服务状态，认证失效时清理页面并返回登录入口。 */
async function handleRefresh(): Promise<void> {
  await system.refresh();

  if (system.unauthorized) {
    auth.invalidateSession();
    system.reset();
    await router.replace({ name: 'login' });
  }
}

/** 先清除私人页面数据，再等待服务端确认退出；失败时允许原位重试。 */
async function handleLogout(): Promise<void> {
  system.reset();

  if (await auth.signOut()) {
    await router.replace({ name: 'login' });
  }
}
</script>

<style scoped lang="scss">
.workspace {
  display: flex;
  min-height: 100svh;
  flex-direction: column;
  padding: 0 clamp(20px, 6vw, 96px);

  &__header {
    display: flex;
    width: 100%;
    max-width: 1200px;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    margin: 0 auto;
    padding: var(--space-6) 0;
    border-bottom: 1px solid var(--color-border);
  }

  &__content {
    display: grid;
    width: 100%;
    max-width: 1060px;
    align-content: start;
    gap: var(--space-6);
    flex: 1;
    margin: 0 auto;
    padding: var(--space-16) 0;
  }

  &__footer {
    display: flex;
    justify-content: center;
    gap: var(--space-3);
    padding: var(--space-6) 0;
    color: var(--color-ink-soft);
    font-size: 0.75rem;
  }
}

.overview {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-6);
  margin-bottom: var(--space-3);

  &__title {
    margin-top: var(--space-3);
    font-family: var(--font-display);
    font-size: 2.5rem;
    font-weight: 400;
    letter-spacing: 0.02em;
  }

  &__description {
    margin-top: var(--space-2);
    color: var(--color-ink-soft);
    font-size: 0.9rem;
  }
}

.status-panel {
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-card);

  &__heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-3);
    padding: var(--space-5) var(--space-6);
    border-bottom: 1px solid var(--color-border);
  }

  &__label {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  &__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-ink-soft);

    &.is-ready {
      background: var(--color-accent);
    }

    &.is-warning {
      background: var(--color-warning);
    }
  }

  &__title {
    font-size: 0.9rem;
    font-weight: 600;
  }

  &__time {
    color: var(--color-ink-soft);
    font-size: 0.75rem;
  }

  &__grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  &__placeholder {
    padding: var(--space-16) var(--space-6);
    color: var(--color-ink-soft);
    font-size: 0.9rem;
    text-align: center;
  }
}

.status-item {
  padding: var(--space-8) var(--space-6);

  & + & {
    border-left: 1px solid var(--color-border);
  }

  &__index {
    color: var(--color-ink-soft);
    font-family: var(--font-display);
    font-size: 0.85rem;
    opacity: 0.65;
  }

  &__title {
    margin-top: var(--space-4);
    color: var(--color-ink-soft);
    font-size: 0.85rem;
    font-weight: 400;
  }

  &__value {
    margin-top: var(--space-1);
    color: var(--color-accent);
    font-size: 1.45rem;
    font-weight: 600;

    &.is-warning {
      color: var(--color-warning);
    }
  }

  &__detail {
    margin-top: var(--space-3);
    color: var(--color-ink-soft);
    font-size: 0.75rem;
    overflow-wrap: anywhere;
  }
}

.foundation-note {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
  padding: var(--space-5) var(--space-6);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);

  &__symbol {
    flex: 0 0 auto;
    color: var(--color-accent);
    font-size: 1.4rem;
    line-height: 1.3;
  }

  &__title {
    font-size: 0.9rem;
    font-weight: 600;
  }

  &__description {
    margin-top: var(--space-1);
    color: var(--color-ink-soft);
    font-size: 0.85rem;
  }
}

@media (max-width: 640px) {
  .workspace {
    &__header {
      flex-wrap: wrap;
      gap: var(--space-2);
      padding: var(--space-4) 0;

      .button {
        margin-left: auto;
      }
    }

    &__content {
      padding: var(--space-10) 0;
    }
  }

  .overview {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--space-5);

    &__title {
      font-size: 2rem;
    }
  }

  .status-panel__grid {
    grid-template-columns: 1fr;
  }

  .status-item {
    padding: var(--space-6);

    & + & {
      border-top: 1px solid var(--color-border);
      border-left: 0;
    }

    &__title {
      margin-top: var(--space-2);
    }
  }
}
</style>
