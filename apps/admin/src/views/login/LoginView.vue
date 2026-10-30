<template>
  <main class="admin-login">
    <header><BrandMark /><span>管理控制台</span></header>
    <section class="login-card" aria-labelledby="login-title">
      <span class="login-card__mark" aria-hidden="true">▦</span>
      <p class="eyebrow">ADMIN CONSOLE</p>
      <h1 id="login-title">登录管理后台</h1>
      <p class="login-card__description">管理伴侣、记忆与部署运行状态。</p>
      <form class="login-card__form" @submit.prevent="handleSubmit">
        <div class="login-card__field">
          <label for="deployment-password" class="login-card__label">部署密码</label>
          <input
            id="deployment-password"
            v-model="password"
            class="login-card__input"
            name="password"
            type="password"
            autocomplete="current-password"
            placeholder="请输入你的密码"
            maxlength="256"
            required
            :disabled="auth.loggingIn"
            :aria-invalid="Boolean(auth.error)"
            :aria-describedby="auth.error ? 'login-error' : undefined"
            @input="handlePasswordInput"
          />
        </div>

        <p v-if="auth.error" id="login-error" class="notice notice--error" role="alert">
          {{ auth.error }}
        </p>

        <button
          class="button button--primary login-card__submit"
          type="submit"
          :disabled="auth.loggingIn || !password"
          :aria-busy="auth.loggingIn"
        >
          {{ auth.loggingIn ? '正在登录…' : '登录' }}
        </button>
      </form>

      <p class="login-card__hint">使用当前部署的访问密码登录。</p>
    </section>
    <footer>Memory Weave · 管理工作空间</footer>
  </main>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import BrandMark from '@/components/BrandMark.vue';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();
const password = ref('');

/** 用户编辑密码时清除上一次请求的错误，不保存输入内容。 */
function handlePasswordInput(): void {
  auth.clearError();
}

/** 等待服务端登录结果后进入私人页面，并清除表单中的密码。 */
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
.login-card__form,
.login-card__field {
  display: grid;
  gap: 12px;
}
.login-card__form {
  gap: 20px;
}
.login-card__label {
  font-size: 13px;
  font-weight: 500;
}
.login-card__input {
  width: 100%;
  min-width: 0;
  height: 44px;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  padding: 0 12px;
  background: #fff;
  color: var(--color-ink);
}
.login-card__submit {
  min-height: 42px;
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
