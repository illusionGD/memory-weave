import { onScopeDispose, ref } from 'vue';
import type { Ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { ApiError } from '@/services/http';

/** 私人人格页面的有界请求状态。 */
export interface PersonaPageState {
  /** 当前正在读取页面数据。 */
  loading: Ref<boolean>;
  /** 当前正在提交命令，期间不重复发起页面操作。 */
  saving: Ref<boolean>;
  /** 可展示的错误提示，未经验证的异常不进入页面。 */
  error: Ref<string | null>;
  /** 执行请求并拒绝离开页面后的迟到结果。 */
  run<T>(operation: () => Promise<T>, mutation?: boolean): Promise<T | null>;
}

/** 页面级请求状态；离开后丢弃旧响应，401 交回登录页。 */
export function usePersonaPage(): PersonaPageState {
  const auth = useAuthStore();
  const router = useRouter();
  const loading = ref(false);
  const saving = ref(false);
  const error = ref<string | null>(null);
  let generation = 0;
  let disposed = false;
  onScopeDispose(() => {
    disposed = true;
    generation++;
  });

  /** @param operation HTTP 操作。 @param mutation 是否为写入。 @returns 仍属于此页面的成功结果。 */
  async function run<T>(operation: () => Promise<T>, mutation = false): Promise<T | null> {
    if (disposed || saving.value) return null;
    const token = ++generation;
    loading.value = !mutation;
    saving.value = mutation;
    error.value = null;
    try {
      const result = await operation();
      return !disposed && token === generation ? result : null;
    } catch (cause: unknown) {
      if (disposed || token !== generation) return null;
      error.value = cause instanceof ApiError ? cause.message : '操作未完成，请稍后重试。';
      if (cause instanceof ApiError && cause.status === 401) {
        auth.invalidateSession();
        await router.replace({ name: 'login' });
      }
      return null;
    } finally {
      if (!disposed && token === generation) {
        loading.value = false;
        saving.value = false;
      }
    }
  }
  return { loading, saving, error, run };
}
