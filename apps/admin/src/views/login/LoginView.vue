<template>
  <main class="admin-login">
    <header><BrandMark /><span>管理控制台</span></header>
    <section class="login-card" aria-labelledby="login-title">
      <span class="login-card__mark" aria-hidden="true">▦</span>
      <p class="eyebrow">ADMIN CONSOLE</p>
      <h1 id="login-title">登录管理后台</h1>
      <p class="login-card__description">管理伴侣、记忆与部署运行状态。</p>
      <div v-if="auth.sessionUnavailable" class="login-card__form">
        <NAlert type="warning" :show-icon="false">
          {{ auth.error }}
        </NAlert>
        <NButton
          type="primary"
          size="large"
          block
          :loading="auth.checkingSession"
          :disabled="auth.checkingSession"
          @click="handleSessionRetry"
        >
          {{ auth.checkingSession ? '正在检查…' : '重新检查登录状态' }}
        </NButton>
      </div>
      <NForm v-else class="login-card__form" @submit.prevent="handleSubmit">
        <NFormItem
          label="部署密码"
          :label-props="{ for: 'deployment-password' }"
          :show-feedback="false"
        >
          <NInput
            v-model:value="password"
            type="password"
            size="large"
            placeholder="请输入你的密码"
            :maxlength="256"
            :disabled="auth.loggingIn"
            :status="auth.error ? 'error' : undefined"
            :input-props="{
              id: 'deployment-password',
              name: 'password',
              autocomplete: 'current-password',
              required: true,
              'aria-invalid': Boolean(auth.error),
              'aria-describedby': auth.error ? 'login-error' : undefined,
            }"
            @update:value="handlePasswordInput"
          />
        </NFormItem>
        <NAlert v-if="auth.error" id="login-error" type="error" :show-icon="false">{{
          auth.error
        }}</NAlert>
        <NButton
          type="primary"
          attr-type="submit"
          size="large"
          block
          :loading="auth.loggingIn"
          :disabled="auth.loggingIn || !password"
        >
          {{ auth.loggingIn ? '正在登录…' : '登录' }}
        </NButton>
      </NForm>

      <p class="login-card__hint">使用当前部署的访问密码登录。</p>
    </section>
    <footer>Memory Weave · 管理工作空间</footer>
  </main>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import { NAlert, NButton, NForm, NFormItem, NInput } from 'naive-ui';
import { useRouter } from 'vue-router';
import BrandMark from '@/components/BrandMark.vue';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();
const password = ref('');

/**
 * 清除密码输入对应的登录错误提示。
 *
 * 用户编辑密码时清除上一次请求的错误，不保存输入内容。
 */
function handlePasswordInput(): void {
  auth.clearError();
}

/**
 * 重新检查保留的登录会话并在恢复后进入应用。
 *
 * 服务暂时不可用时不要求重新输入密码，只有会话明确失效才显示登录表单。
 */
async function handleSessionRetry(): Promise<void> {
  if (auth.checkingSession) return;
  if (await auth.restoreSession()) await router.replace({ name: 'status' });
}

/**
 * 提交登录表单并跳转到目标页面。
 *
 * 等待服务端登录结果后进入私人页面，并清除表单中的密码。
 */
async function handleSubmit(): Promise<void> {
  if (auth.loggingIn || !password.value) {
    return;
  }

  const loggedIn = await auth.signIn(password.value);

  if (loggedIn) {
    password.value = '';
    await router.replace({ name: 'status' });
  }
}
</script>

<style scoped lang="scss">
.admin-login {
  min-height: 100svh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 36px 24px;
  background: linear-gradient(130deg, #edf1f8, #f8fafc);
}
.admin-login header {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-bottom: 34px;
}
.admin-login header > span {
  border-left: 1px solid #bac5d7;
  padding-left: 18px;
  font-size: 12px;
  color: var(--color-ink-soft);
}
.admin-login footer {
  margin-top: 32px;
  font-size: 11px;
  color: #8390a5;
}
.login-card {
  width: min(100%, 420px);
  padding: 36px;
  background: white;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  box-shadow: 0 14px 50px #1d355710;
}
.login-card__mark {
  font-size: 28px;
  color: var(--color-accent);
}
.login-card .eyebrow {
  margin: 12px 0 6px;
  font-size: 10px;
  color: #8698b4;
}
.login-card h1 {
  font-size: 24px;
}
.login-card__description {
  margin: 8px 0 28px;
  font-size: 13px;
  color: var(--color-ink-soft);
}
.login-card__form {
  display: grid;
  gap: 12px;
}
.login-card__form {
  gap: 20px;
}
.login-card__hint {
  font-size: 11px;
  color: var(--color-ink-soft);
  text-align: center;
  margin-top: 22px;
}
@media (max-width: 500px) {
  .login-card {
    padding: 28px 24px;
  }
}
</style>
