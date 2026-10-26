<template>
  <main class="settings">
    <header class="settings__header">
      <BrandMark />
      <nav class="settings__navigation" aria-label="个人空间">
        <RouterLink class="button button--quiet" :to="{ name: 'status' }">运行状态</RouterLink>
        <button
          class="button button--quiet"
          type="button"
          :disabled="auth.loggingOut"
          :aria-busy="auth.loggingOut"
          @click="handleLogout"
        >
          {{ auth.loggingOut ? '正在退出…' : '退出登录' }}
        </button>
      </nav>
    </header>

    <div class="settings__content">
      <section class="settings__intro" aria-labelledby="settings-title">
        <p class="eyebrow">A name of your own</p>
        <h1 id="settings-title" class="settings__title">个人设置</h1>
        <p class="settings__description">让这份私人空间认识你的名字。</p>
      </section>

      <p v-if="auth.error" class="notice notice--error" role="alert">{{ auth.error }}</p>

      <section class="profile-card" aria-labelledby="profile-title" :aria-busy="workspace.loading">
        <div class="profile-card__heading">
          <h2 id="profile-title" class="profile-card__title">你的名字</h2>
          <p class="profile-card__description">
            显示名称用于个人资料。修改名字后，过去的对话仍属于你。
          </p>
        </div>

        <p v-if="workspace.loading" class="profile-card__loading" role="status">
          正在读取个人资料…
        </p>

        <form
          v-if="workspace.workspace"
          class="profile-card__form"
          novalidate
          @submit.prevent="handleSave"
        >
          <div class="profile-card__field">
            <label for="display-name" class="profile-card__label">显示名称</label>
            <input
              id="display-name"
              v-model="displayName"
              class="profile-card__input"
              name="displayName"
              type="text"
              autocomplete="nickname"
              :disabled="workspace.saving || auth.loggingOut"
              :aria-invalid="Boolean(workspace.validationError)"
              :aria-describedby="inputDescription"
              @input="handleNameInput"
            />
            <p id="name-hint" class="profile-card__hint">1～80 个字符，首尾空白会自动去除。</p>
          </div>

          <p v-if="feedbackError" id="name-error" class="notice notice--error" role="alert">
            {{ feedbackError }}
          </p>
          <p v-if="workspace.saved" class="profile-card__success" role="status">显示名称已保存。</p>

          <button
            class="button button--primary profile-card__save"
            type="submit"
            :disabled="workspace.saving || auth.loggingOut"
            :aria-busy="workspace.saving"
          >
            {{ workspace.saving ? '正在保存…' : '保存名称' }}
          </button>
        </form>

        <div v-else-if="!workspace.loading" class="profile-card__retry">
          <p v-if="workspace.error" class="notice notice--error" role="alert">
            {{ workspace.error }}
          </p>
          <button
            class="button button--secondary"
            type="button"
            :disabled="auth.loggingOut"
            @click="handleLoad"
          >
            重新读取
          </button>
        </div>
      </section>
    </div>

    <footer class="settings__footer">
      Memory Weave <span aria-hidden="true">·</span> 私人部署
    </footer>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import BrandMark from '@/components/BrandMark.vue';
import { useAuthStore } from '@/stores/auth';
import { useWorkspaceStore } from '@/stores/workspace';

const auth = useAuthStore();
const workspace = useWorkspaceStore();
const router = useRouter();
const displayName = ref('');
const feedbackError = computed(() => workspace.validationError ?? workspace.error);
const inputDescription = computed(() =>
  feedbackError.value ? 'name-hint name-error' : 'name-hint',
);

onMounted(handleLoad);
onBeforeUnmount(workspace.reset);

/** 重新读取资料，只有当前页面的有效响应可以更新输入框。 */
async function handleLoad(): Promise<void> {
  if (auth.loggingOut) return;
  if (await workspace.load()) displayName.value = workspace.workspace?.displayName ?? '';
  await handleUnauthorized();
}

/** 输入改变后清除上一次保存的提示，不提前改变持久名称。 */
function handleNameInput(): void {
  workspace.clearFeedback();
}

/** 保存后采用服务端规范化的名称，失败时保留用户输入供重试。 */
async function handleSave(): Promise<void> {
  if (auth.loggingOut) return;
  if (await workspace.save(displayName.value))
    displayName.value = workspace.workspace?.displayName ?? '';
  await handleUnauthorized();
}

/** 私有接口失去认证时清理资料并返回登录入口。 */
async function handleUnauthorized(): Promise<void> {
  if (!workspace.unauthorized) return;
  auth.invalidateSession();
  workspace.reset();
  displayName.value = '';
  await router.replace({ name: 'login' });
}

/** 清理页面资料，再等待服务端确认退出；失败时允许再次退出或重新读取。 */
async function handleLogout(): Promise<void> {
  workspace.reset();
  displayName.value = '';
  if (await auth.signOut()) await router.replace({ name: 'login' });
}
</script>

<style scoped lang="scss">
.settings {
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
    flex-wrap: wrap;
    gap: var(--space-4);
    margin: 0 auto;
    padding: var(--space-6) 0;
    border-bottom: 1px solid var(--color-border);
  }

  &__navigation {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-left: auto;
  }

  &__content {
    display: grid;
    width: 100%;
    max-width: 720px;
    flex: 1;
    align-content: start;
    gap: var(--space-8);
    margin: 0 auto;
    padding: var(--space-16) 0;
  }

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

  &__footer {
    display: flex;
    justify-content: center;
    gap: var(--space-3);
    padding: var(--space-6) 0;
    color: var(--color-ink-soft);
    font-size: 0.75rem;
  }
}

.profile-card {
  padding: var(--space-8);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-card);

  &__heading {
    margin-bottom: var(--space-6);
  }

  &__title {
    font-size: 1.1rem;
    font-weight: 600;
  }

  &__description,
  &__loading {
    margin-top: var(--space-2);
    color: var(--color-ink-soft);
    font-size: 0.85rem;
  }

  &__form,
  &__retry {
    display: grid;
    gap: var(--space-5);
  }

  &__field {
    display: grid;
    gap: var(--space-2);
  }

  &__label {
    font-size: 0.85rem;
    font-weight: 600;
  }

  &__input {
    width: 100%;
    min-width: 0;
    height: 50px;
    padding: 0 var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    color: var(--color-ink);
  }

  &__hint {
    color: var(--color-ink-soft);
    font-size: 0.75rem;
  }

  &__success {
    color: var(--color-accent);
    font-size: 0.85rem;
  }

  &__save {
    justify-self: start;
    min-width: 140px;
  }
}

@media (max-width: 640px) {
  .settings {
    &__header {
      gap: var(--space-2);
      padding: var(--space-4) 0;
    }

    &__content {
      padding: var(--space-10) 0;
      gap: var(--space-6);
    }

    &__title {
      font-size: 2rem;
    }
  }

  .profile-card {
    padding: var(--space-6);

    &__save {
      width: 100%;
    }
  }
}
</style>
