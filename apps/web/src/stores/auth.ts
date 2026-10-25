import { defineStore } from 'pinia';
import { ref } from 'vue';
import * as authApi from '@/services/auth';
import { ApiError } from '@/services/http';

/** 会话只保存于内存，真实认证由服务端 HttpOnly Cookie 决定。 */
export const useAuthStore = defineStore('auth', () => {
  const authenticated = ref(false);
  const initialized = ref(false);
  const loggingIn = ref(false);
  const loggingOut = ref(false);
  const error = ref<string | null>(null);
  let sessionRequest: Promise<boolean> | null = null;

  /**
   * 路由首次进入时恢复会话；并发导航共用一次检查。
   * @returns 服务端是否确认当前会话有效。
   */
  async function restoreSession(): Promise<boolean> {
    if (initialized.value) {
      return authenticated.value;
    }

    if (sessionRequest) {
      return sessionRequest;
    }

    sessionRequest = checkSession();

    try {
      return await sessionRequest;
    } finally {
      sessionRequest = null;
    }
  }

  /**
   * 检查会话并将服务失联与正常未登录区分显示。
   * @returns 当前会话是否有效。
   */
  async function checkSession(): Promise<boolean> {
    try {
      await authApi.getSession();
      authenticated.value = true;
      error.value = null;
    } catch (cause: unknown) {
      authenticated.value = false;
      error.value =
        cause instanceof ApiError && cause.status === 401
          ? null
          : '暂时无法检查登录状态，请确认服务可用后重试。';
    } finally {
      initialized.value = true;
    }

    return authenticated.value;
  }

  /**
   * 登录成功后仅记录认证状态，密码不会存入 store。
   * @param password 本次表单输入的部署密码。
   * @returns 是否成功登录。
   */
  async function signIn(password: string): Promise<boolean> {
    loggingIn.value = true;
    error.value = null;

    try {
      await authApi.login(password);
      authenticated.value = true;
      initialized.value = true;
      return true;
    } catch (cause: unknown) {
      authenticated.value = false;
      error.value =
        cause instanceof ApiError
          ? cause.status === 401
            ? '密码不正确，请重试。'
            : cause.message
          : '登录信息有误，请检查后重试。';
      return false;
    } finally {
      loggingIn.value = false;
    }
  }

  /**
   * 等待服务端撤销会话；失败时保留重试入口，不伪称已经退出。
   * @returns 服务端是否已确认退出。
   */
  async function signOut(): Promise<boolean> {
    loggingOut.value = true;
    error.value = null;

    try {
      await authApi.logout();
      invalidateSession(null);
      return true;
    } catch (cause: unknown) {
      if (cause instanceof ApiError && cause.status === 401) {
        invalidateSession(null);
        return true;
      }

      error.value = '退出尚未确认，请恢复连接后重试。';
      return false;
    } finally {
      loggingOut.value = false;
    }
  }

  /**
   * 私有接口返回未认证时清除本地会话，交由页面重新登录。
   * @param message 登录页面应显示的原因；主动退出时为 null。
   */
  function invalidateSession(message: string | null = '登录已过期，请重新登录。'): void {
    authenticated.value = false;
    initialized.value = true;
    error.value = message;
  }

  /** 用户重新输入时清除上一条登录反馈。 */
  function clearError(): void {
    error.value = null;
  }

  return {
    authenticated,
    initialized,
    loggingIn,
    loggingOut,
    error,
    restoreSession,
    signIn,
    signOut,
    invalidateSession,
    clearError,
  };
});
