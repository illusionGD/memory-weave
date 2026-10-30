<template>
  <AdminLayout>
    <div class="workspace__content">
      <section class="overview" aria-labelledby="status-title">
        <div>
          <p class="eyebrow">WORKSPACE OVERVIEW</p>
          <h1 id="status-title" class="overview__title">运行状态</h1>
          <p class="overview__description">服务连接、存储与数据结构的实时检查。</p>
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
            <p class="status-item__detail">{{ databaseDetail }}</p>
          </article>

          <article class="status-item">
            <span class="status-item__index" aria-hidden="true">03</span>
            <h3 class="status-item__title">数据结构</h3>
            <p class="status-item__value" :class="schemaClass">{{ schemaLabel }}</p>
            <p class="status-item__detail">{{ schemaDetail }}</p>
          </article>

          <article class="status-item">
            <span class="status-item__index" aria-hidden="true">04</span>
            <h3 class="status-item__title">向量服务</h3>
            <p class="status-item__value" :class="vectorClass">{{ vectorLabel }}</p>
            <p class="status-item__detail">{{ vectorDetail }}</p>
          </article>

          <article class="status-item">
            <span class="status-item__index" aria-hidden="true">05</span>
            <h3 class="status-item__title">附件目录</h3>
            <p class="status-item__value" :class="storageClass">{{ storageLabel }}</p>
            <p class="status-item__detail">{{ storageDetail }}</p>
          </article>
        </div>

        <p v-else class="status-panel__placeholder" role="status">{{ placeholderLabel }}</p>
      </section>

      <section class="quick-links" aria-label="管理入口">
        <RouterLink to="/companions"
          ><span>01 / COMPANIONS</span>
          <h2>伴侣管理 <span aria-hidden="true">↗</span></h2>
          <p>查看人格版本、初始人生与实例状态</p></RouterLink
        >
        <RouterLink to="/memories"
          ><span>02 / MEMORIES</span>
          <h2>记忆记录 <span aria-hidden="true">↗</span></h2>
          <p>回查来源、整理批次与历史变更</p></RouterLink
        >
        <RouterLink to="/lifecycle"
          ><span>03 / OPERATIONS</span>
          <h2>清理记录 <span aria-hidden="true">↗</span></h2>
          <p>追踪内容删除与实例重置的执行结果</p></RouterLink
        >
      </section>
    </div>
  </AdminLayout>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import AdminLayout from '@/components/AdminLayout.vue';
import { useAuthStore } from '@/stores/auth';
import { useSystemStore } from '@/stores/system';

const auth = useAuthStore();
const system = useSystemStore();
const router = useRouter();

const databaseReady = computed(() => system.status?.database.status === 'connected');
const storageReady = computed(() => system.status?.storage.status === 'ready');
const schemaReady = computed(() => system.status?.schema.status === 'ready');
const vectorReady = computed(() => system.status?.vectorStore.status === 'connected');
const allReady = computed(
  () => databaseReady.value && vectorReady.value && storageReady.value && schemaReady.value,
);
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
const databaseDetail = computed(() =>
  system.status?.database.version ? `MySQL ${system.status.database.version}` : '请检查数据库连接',
);
const vectorLabel = computed(() => (vectorReady.value ? '已连接' : '暂不可用'));
const vectorClass = computed(() => ({ 'is-warning': !vectorReady.value }));
const vectorDetail = computed(() =>
  system.status?.vectorStore.version
    ? `Qdrant ${system.status.vectorStore.version}`
    : '请检查向量服务连接与访问密钥',
);
const storageLabel = computed(() => (storageReady.value ? '可读写' : '暂不可用'));
const storageClass = computed(() => ({ 'is-warning': !storageReady.value }));
const storageDetail = computed(() =>
  storageReady.value ? '持久目录已准备好' : '请检查目录权限与磁盘空间',
);
const schemaClass = computed(() => ({ 'is-warning': !schemaReady.value }));
const schemaLabel = computed(() => {
  if (schemaReady.value) return '已就绪';
  return system.status?.schema.status === 'pending' ? '待升级' : '暂不可用';
});
const schemaDetail = computed(() => {
  if (schemaReady.value) return '与当前服务版本一致';
  return system.status?.schema.status === 'pending'
    ? '请按启动文档完成数据库升级'
    : '请检查数据库连接与升级记录';
});
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
</script>

<style scoped lang="scss">
.workspace__content {
  display: grid;
  gap: 24px;
}
.overview {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
}
.overview__title {
  font-size: 26px;
  font-weight: 600;
  margin: 4px 0;
}
.overview__description {
  color: var(--color-ink-soft);
  font-size: 13px;
}
.overview .eyebrow {
  font-size: 10px;
  letter-spacing: 2px;
  color: #8795ac;
}
.status-panel {
  border: 1px solid var(--color-border);
  background: white;
  border-radius: 8px;
  overflow: hidden;
}
.status-panel__heading {
  padding: 18px 22px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--color-border);
}
.status-panel__label {
  display: flex;
  gap: 9px;
  align-items: center;
}
.status-panel__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #94a0b0;
}
.status-panel__dot.is-ready {
  background: #58a282;
}
.status-panel__dot.is-warning {
  background: var(--color-warning);
}
.status-panel__title {
  font-size: 14px;
}
.status-panel__time {
  font-size: 11px;
  color: var(--color-ink-soft);
}
.status-panel__grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
}
.status-panel__placeholder {
  padding: 60px 24px;
  color: var(--color-ink-soft);
  text-align: center;
}
.status-item {
  padding: 24px 22px 28px;
}
.status-item + .status-item {
  border-left: 1px solid var(--color-border);
}
.status-item__index {
  display: none;
}
.status-item__title {
  font-size: 12px;
  font-weight: 400;
  color: var(--color-ink-soft);
}
.status-item__value {
  font-size: 22px;
  font-weight: 600;
  margin: 10px 0;
  color: #3e6e5c;
}
.status-item__value.is-warning {
  color: var(--color-warning);
}
.status-item__detail {
  font-size: 11px;
  color: var(--color-ink-soft);
  overflow-wrap: anywhere;
}
.quick-links {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 20px;
}
.quick-links a {
  display: grid;
  gap: 12px;
  background: white;
  padding: 24px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  text-decoration: none;
  transition: border-color 0.2s;
}
.quick-links a:hover {
  border-color: var(--color-accent);
}
.quick-links a > span {
  font-size: 9px;
  letter-spacing: 1px;
  color: #8997ad;
}
.quick-links h2 {
  display: flex;
  justify-content: space-between;
  font-size: 15px;
  color: var(--color-ink);
}
.quick-links p {
  font-size: 12px;
  color: var(--color-ink-soft);
}
@media (max-width: 1100px) {
  .status-panel__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .status-item + .status-item {
    border-left: 0;
  }
  .quick-links {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 600px) {
  .overview {
    align-items: flex-start;
    flex-direction: column;
  }
  .status-panel__heading {
    flex-wrap: wrap;
  }
}
</style>
