<template>
  <main class="login-page">
    <header class="login-page__header"><BrandMark /></header>

    <div class="login-page__content">
      <section class="story" aria-labelledby="welcome-title">
        <p class="eyebrow">A place for stories to stay</p>
        <h1 id="welcome-title" class="story__title">留住相处，<br />让故事继续。</h1>
        <p class="story__description">
          属于你和伴侣的私人空间。<br />从一次相遇，慢慢织成一段人生。
        </p>
        <div class="story__threads" aria-hidden="true">
          <span class="story__thread story__thread--one"></span>
          <span class="story__thread story__thread--two"></span>
          <span class="story__thread story__thread--three"></span>
        </div>
      </section>

      <section class="login-card" aria-labelledby="login-title">
        <div class="login-card__heading">
          <span class="login-card__symbol" aria-hidden="true">↗</span>
          <p class="eyebrow">Your private space</p>
          <h2 id="login-title" class="login-card__title">欢迎回来</h2>
          <p class="login-card__description">使用部署时设置的密码进入。</p>
        </div>

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

        <p class="login-card__hint">此入口仅供当前部署的使用者访问。</p>
      </section>
    </div>

    <footer class="login-page__footer">
      Memory Weave <span aria-hidden="true">·</span> 私人部署
    </footer>
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
    await router.replace({ name: 'chats' });
  }
}
</script>

<style scoped lang="scss">
.login-page {
  display: flex;
  min-height: 100svh;
  flex-direction: column;
  padding: var(--space-10) clamp(24px, 7vw, 112px) var(--space-6);
  background: radial-gradient(ellipse at 20% 55%, #28253e 0, transparent 48%), var(--color-canvas);

  &__header {
    width: 100%;
    max-width: 1200px;
    margin: 0 auto;
  }

  &__content {
    display: grid;
    width: 100%;
    max-width: 1060px;
    flex: 1;
    grid-template-columns: 1fr 400px;
    align-items: center;
    gap: var(--space-16);
    margin: 0 auto;
    padding: var(--space-16) 0;
  }

  &__footer {
    display: flex;
    justify-content: center;
    gap: var(--space-3);
    color: var(--color-ink-soft);
    font-size: 0.75rem;
  }
}

.story {
  position: relative;
  padding-bottom: var(--space-16);

  &__title {
    margin-top: var(--space-6);
    font-family: var(--font-display);
    font-size: clamp(2.5rem, 4.5vw, 4rem);
    font-weight: 400;
    line-height: 1.5;
    letter-spacing: 0.02em;
  }

  &__description {
    margin-top: var(--space-6);
    color: var(--color-ink-soft);
    font-size: 0.95rem;
    line-height: 2;
  }

  &__threads {
    position: relative;
    width: 220px;
    height: 64px;
    margin-top: var(--space-10);
  }

  &__thread {
    position: absolute;
    width: 180px;
    height: 52px;
    border: 1px solid var(--color-accent);
    border-radius: 50%;
    opacity: 0.25;

    &--one {
      top: 0;
      left: 0;
      transform: rotate(-12deg);
    }

    &--two {
      top: 8px;
      left: 16px;
      transform: rotate(8deg);
    }

    &--three {
      top: 12px;
      left: 30px;
      transform: rotate(-4deg);
    }
  }
}

.login-card {
  padding: var(--space-10);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-card);

  &__heading {
    margin-bottom: var(--space-8);
  }

  &__symbol {
    display: flex;
    width: 44px;
    height: 44px;
    align-items: center;
    justify-content: center;
    margin-bottom: var(--space-6);
    border-radius: 50%;
    background: var(--color-accent-soft);
    color: var(--color-accent);
    font-size: 1.5rem;
  }

  &__title {
    margin-top: var(--space-2);
    font-size: 1.6rem;
    font-weight: 600;
  }

  &__description {
    margin-top: var(--space-2);
    color: var(--color-ink-soft);
    font-size: 0.9rem;
  }

  &__form {
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

    &::placeholder {
      color: var(--color-ink-soft);
      opacity: 0.75;
    }
  }

  &__submit {
    width: 100%;
  }

  &__hint {
    margin-top: var(--space-6);
    color: var(--color-ink-soft);
    font-size: 0.75rem;
    text-align: center;
  }
}

@media (max-width: 800px) {
  .login-page {
    padding-top: var(--space-6);

    &__content {
      max-width: 440px;
      grid-template-columns: 1fr;
      gap: var(--space-8);
      padding: var(--space-10) 0;
    }
  }

  .story {
    padding-bottom: 0;

    &__title {
      margin-top: var(--space-3);
      font-size: 2.3rem;
      line-height: 1.4;
    }

    &__description {
      margin-top: var(--space-3);
      font-size: 0.85rem;
    }

    &__threads {
      display: none;
    }
  }

  .login-card {
    padding: var(--space-6);

    &__symbol {
      display: none;
    }

    &__heading {
      margin-bottom: var(--space-6);
    }
  }
}
</style>
