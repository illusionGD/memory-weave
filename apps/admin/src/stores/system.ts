import type { SystemStatus } from '@memory-weave/contracts';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { ApiError } from '@memory-weave/browser-client/http';
import { getSystemStatus } from '@memory-weave/browser-client/system';

/** 运行状态只保留当前查询结果；退出时清理并使在途响应失效。 */
export const useSystemStore = defineStore('system', () => {
  const status = ref<SystemStatus | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const unauthorized = ref(false);
  const checkedAt = ref<Date | null>(null);
  let requestVersion = 0;

  /** 查询最新状态；旧请求不能覆盖退出或更新后的界面。 */
  async function refresh(): Promise<void> {
    const currentVersion = ++requestVersion;
    loading.value = true;
    error.value = null;
    unauthorized.value = false;
    status.value = null;
    checkedAt.value = null;

    try {
      const result = await getSystemStatus();

      if (currentVersion !== requestVersion) {
        return;
      }

      status.value = result;
      checkedAt.value = new Date();
    } catch (cause: unknown) {
      if (currentVersion !== requestVersion) {
        return;
      }

      unauthorized.value = cause instanceof ApiError && cause.status === 401;
      error.value = cause instanceof ApiError ? cause.message : '状态读取失败，请重试。';
    } finally {
      if (currentVersion === requestVersion) {
        loading.value = false;
      }
    }
  }

  /** 清除私有状态并阻止退出前的在途响应重新填入页面。 */
  function reset(): void {
    requestVersion += 1;
    status.value = null;
    loading.value = false;
    error.value = null;
    unauthorized.value = false;
    checkedAt.value = null;
  }

  return { status, loading, error, unauthorized, checkedAt, refresh, reset };
});
