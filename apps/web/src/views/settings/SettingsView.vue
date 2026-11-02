<template>
  <ChatLayout>
    <div class="settings__content">
      <section class="settings__intro" aria-labelledby="settings-title">
        <p class="eyebrow">A name of your own</p>
        <h1 id="settings-title" class="settings__title">个人设置</h1>
        <p class="settings__description">让这份私人空间认识你的名字。</p>
      </section>

      <NAlert v-if="auth.error" type="error" :show-icon="false">{{ auth.error }}</NAlert>

      <section class="profile-card" aria-labelledby="profile-title" :aria-busy="workspace.loading">
        <div class="profile-card__heading">
          <h2 id="profile-title" class="profile-card__title">你的名字</h2>
          <p class="profile-card__description">
            显示名称用于个人资料。修改名字后，过去的对话仍属于你。
          </p>
        </div>

        <div v-if="workspace.loading" class="profile-card__loading" role="status">
          <NSpin size="small" />正在读取个人资料…
        </div>

        <NForm
          v-if="workspace.workspace"
          class="profile-card__form"
          :show-feedback="false"
          novalidate
          @submit.prevent="handleSave"
        >
          <NFormItem
            label="显示名称"
            :label-props="{ for: 'display-name' }"
            :validation-status="workspace.validationError ? 'error' : undefined"
          >
            <div class="profile-card__field">
              <NInput
                v-model:value="displayName"
                :input-props="{
                  id: 'display-name',
                  autocomplete: 'nickname',
                  name: 'displayName',
                  'aria-invalid': Boolean(workspace.validationError),
                  'aria-describedby': inputDescription,
                }"
                :disabled="workspace.saving || auth.loggingOut"
                @update:value="handleNameInput"
              />
              <p id="name-hint" class="profile-card__hint">1～80 个字符，首尾空白会自动去除。</p>
            </div>
          </NFormItem>

          <NAlert v-if="feedbackError" id="name-error" type="error" :show-icon="false">
            {{ feedbackError }}
          </NAlert>
          <p v-if="workspace.saved" role="status"><NText type="success">显示名称已保存。</NText></p>

          <NButton
            class="profile-card__save"
            type="primary"
            attr-type="submit"
            :disabled="workspace.saving || auth.loggingOut"
            :loading="workspace.saving"
          >
            {{ workspace.saving ? '正在保存…' : '保存名称' }}
          </NButton>
        </NForm>

        <div v-else-if="!workspace.loading" class="profile-card__retry">
          <NAlert v-if="workspace.error" type="error" :show-icon="false">
            {{ workspace.error }}
          </NAlert>
          <NButton secondary :disabled="auth.loggingOut" @click="handleLoad"> 重新读取 </NButton>
        </div>
      </section>
    </div>
  </ChatLayout>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { NAlert, NButton, NForm, NFormItem, NInput, NSpin, NText } from 'naive-ui';
import { useRouter } from 'vue-router';
import ChatLayout from '@/components/ChatLayout.vue';
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

/**
 * 加载用户资料并更新编辑表单。
 *
 * 重新读取资料，只有当前页面的有效响应可以更新输入框。
 */
async function handleLoad(): Promise<void> {
  if (auth.loggingOut) return;
  if (await workspace.load()) displayName.value = workspace.workspace?.displayName ?? '';
  await handleUnauthorized();
}

/**
 * 清除显示名称编辑过程中的旧提示。
 *
 * 输入改变后清除上一次保存的提示，不提前改变持久名称。
 */
function handleNameInput(): void {
  workspace.clearFeedback();
}

/**
 * 保存用户显示名称并更新表单。
 *
 * 保存后采用服务端规范化的名称，失败时保留用户输入供重试。
 */
async function handleSave(): Promise<void> {
  if (auth.loggingOut) return;
  if (await workspace.save(displayName.value))
    displayName.value = workspace.workspace?.displayName ?? '';
  await handleUnauthorized();
}

/**
 * 清理失效登录状态并返回登录页面。
 *
 * 私有接口失去认证时清理资料并返回登录入口。
 */
async function handleUnauthorized(): Promise<void> {
  if (!workspace.unauthorized) return;
  auth.invalidateSession();
  workspace.reset();
  displayName.value = '';
  await router.replace({ name: 'login' });
}
</script>

<style scoped lang="scss">
.settings {
  &__content {
    display: grid;
    width: 100%;
    max-width: 720px;
    flex: 1;
    align-content: start;
    gap: var(--space-8);
    margin: 0 auto;
    padding: var(--space-4) 0;
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
}
.profile-card {
  padding: var(--space-8);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
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
  &__loading {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  &__form,
  &__retry {
    display: grid;
    gap: var(--space-5);
  }
  &__field {
    display: grid;
    width: 100%;
    min-width: 0;
    gap: var(--space-2);
  }
  &__hint {
    color: var(--color-ink-soft);
    font-size: 0.75rem;
  }
  &__save {
    justify-self: start;
    min-width: 140px;
  }
}
@media (max-width: 640px) {
  .settings {
    &__content {
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
