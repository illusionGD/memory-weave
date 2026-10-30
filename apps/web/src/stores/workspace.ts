import { updateWorkspaceRequestSchema, type WorkspaceResponse } from '@memory-weave/contracts';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { ApiError } from '@memory-weave/browser-client/http';
import { getWorkspace, updateWorkspace } from '@memory-weave/browser-client/workspace';

/** 用户资料只保留在当前页面会话内；离开或退出后丢弃在途请求结果。 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const workspace = ref<WorkspaceResponse | null>(null);
  const loading = ref(false);
  const saving = ref(false);
  const error = ref<string | null>(null);
  const validationError = ref<string | null>(null);
  const unauthorized = ref(false);
  const saved = ref(false);
  let requestVersion = 0;

  /**
   * 读取最新资料；旧页面请求不能覆盖后续页面的状态。
   * @returns 是否取得当前有效的资料。
   */
  async function load(): Promise<boolean> {
    const currentVersion = ++requestVersion;
    loading.value = true;
    saving.value = false;
    workspace.value = null;
    unauthorized.value = false;
    clearFeedback();

    try {
      const result = await getWorkspace();
      if (currentVersion !== requestVersion) return false;
      workspace.value = result;
      return true;
    } catch (cause: unknown) {
      if (currentVersion !== requestVersion) return false;
      unauthorized.value = cause instanceof ApiError && cause.status === 401;
      error.value = cause instanceof ApiError ? cause.message : '个人资料读取失败，请重试。';
      return false;
    } finally {
      if (currentVersion === requestVersion) loading.value = false;
    }
  }

  /**
   * 按共享规则验证名称，再等待服务端确认保存成功。
   * @param displayName 用户当前输入，公共契约负责去除首尾空白。
   * @returns 是否成功保存且结果仍属于当前页面。
   */
  async function save(displayName: string): Promise<boolean> {
    if (loading.value || saving.value || !workspace.value) return false;
    clearFeedback();
    const parsed = updateWorkspaceRequestSchema.safeParse({ displayName });
    if (!parsed.success) {
      validationError.value = '请输入 1～80 个字符的显示名称。';
      return false;
    }
    const currentVersion = ++requestVersion;
    saving.value = true;
    unauthorized.value = false;

    try {
      const result = await updateWorkspace(parsed.data);
      if (currentVersion !== requestVersion) return false;
      workspace.value = result;
      saved.value = true;
      return true;
    } catch (cause: unknown) {
      if (currentVersion !== requestVersion) return false;
      unauthorized.value = cause instanceof ApiError && cause.status === 401;
      error.value =
        cause instanceof ApiError ? cause.message : '名称保存未确认，请重试或刷新后核对。';
      return false;
    } finally {
      if (currentVersion === requestVersion) saving.value = false;
    }
  }

  /** 编辑名称后清除过时的成功或失败提示，保留已读取的资料。 */
  function clearFeedback(): void {
    error.value = null;
    validationError.value = null;
    saved.value = false;
  }

  /** 清空私人资料并使所有旧请求失效，不伪称取消了服务端已接受的写入。 */
  function reset(): void {
    requestVersion += 1;
    workspace.value = null;
    loading.value = false;
    saving.value = false;
    unauthorized.value = false;
    clearFeedback();
  }

  return {
    workspace,
    loading,
    saving,
    error,
    validationError,
    unauthorized,
    saved,
    load,
    save,
    clearFeedback,
    reset,
  };
});
