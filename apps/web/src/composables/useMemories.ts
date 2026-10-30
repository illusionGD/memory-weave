import { computed, onScopeDispose, ref, watch } from 'vue';
import type { Ref } from 'vue';
import type {
  MemoryDetail,
  MemoryItem,
  MemoryQuery,
  PublishedMessage,
} from '@memory-weave/contracts';
import { usePersonaPage } from './usePersonaPage';
import {
  getMemoryEvidence,
  getMemory,
  listMemories,
  memorySource,
} from '@memory-weave/browser-client/memories';

/** 只读记忆浏览与来源回查；失败时清除旧正文，避免保留失效内容。 */
export function useMemories(
  companionId: Ref<string>,
  conversationId: Ref<string>,
  epoch: Ref<number>,
) {
  const page = usePersonaPage();
  const items = ref<MemoryItem[]>([]);
  const detail = ref<MemoryDetail | null>(null);
  const source = ref<PublishedMessage | null>(null);
  const next = ref<string | null>(null);
  const selected = ref<string | null>(null);
  const query = computed<MemoryQuery>(() => ({
    runtimeEpoch: epoch.value,
    conversationId: conversationId.value,
    limit: 20,
  }));
  const memoryAfter = ref<string | undefined>();
  let generation = 0;
  let disposed = false;
  /** 清除可能已因删除、重置或权限变更而失效的内容。 */
  function clear() {
    items.value = [];
    detail.value = null;
    source.value = null;
    next.value = null;
  }
  /** 每次从当前 scope 读取，拒绝路由切换后的迟到响应。 */
  async function refresh() {
    if (page.saving.value || page.loading.value || disposed) return;
    const token = generation;
    const result = await page.run(async () => {
      const [list, record] = await Promise.all([
        listMemories(companionId.value, { ...query.value, afterId: memoryAfter.value }),
        selected.value
          ? getMemory(companionId.value, selected.value, query.value)
          : Promise.resolve(null),
      ]);
      return { list, record };
    });
    if (token !== generation) return;
    if (!result) {
      clear();
      return;
    }
    items.value = result.list.items;
    next.value = result.list.nextAfterId;
    if (
      !detail.value ||
      detail.value.current.versionId !== result.record?.current.versionId ||
      detail.value.current.status !== result.record?.current.status
    ) {
      detail.value = result.record;
      source.value = null;
    }
  }
  /** 页面保持有界，轮询不把读者带回第一页。 */
  async function more() {
    if (!next.value) return;
    memoryAfter.value = next.value;
    await refresh();
  }
  /** 返回当前记忆的第一页。 */
  async function first() {
    memoryAfter.value = undefined;
    await refresh();
  }
  /** 版本证据始终从服务端当前有效范围读取。 */
  async function inspect(id: string) {
    selected.value = id;
    detail.value = null;
    source.value = null;
    const token = generation;
    const result = await page.run(() => getMemory(companionId.value, id, query.value));
    if (token === generation) {
      detail.value = result;
      if (!result) clear();
    }
  }
  /** 继续读取较早的语义版本，不重复加载当前页。 */
  async function moreVersions() {
    if (!selected.value || !detail.value?.nextAfterId) return;
    const token = generation;
    const result = await page.run(() =>
      getMemory(companionId.value, selected.value!, {
        ...query.value,
        afterId: detail.value!.nextAfterId!,
      }),
    );
    if (token !== generation) return;
    if (!result) {
      clear();
      return;
    }
    if (detail.value) {
      detail.value.versions.push(...result.versions);
      detail.value.nextAfterId = result.nextAfterId;
    }
  }
  /** 只追加一个版本的证据页；后续轮询仍检查该记忆是否有效。 */
  async function moreEvidence(versionId: string) {
    const version = detail.value?.versions.find((item) => item.versionId === versionId);
    if (!selected.value || !version?.evidenceNextAfterId) return;
    const token = generation;
    const result = await page.run(() =>
      getMemoryEvidence(companionId.value, selected.value!, versionId, {
        ...query.value,
        afterId: version.evidenceNextAfterId!,
      }),
    );
    if (token !== generation) return;
    if (!result) {
      clear();
      return;
    }
    version.evidence.push(...result.items);
    version.evidenceNextAfterId = result.nextAfterId;
  }
  /** 回查引用的完整原文，不将此读取视为新的佐证。 */
  async function showSource(messageId: string, version: number) {
    const token = generation;
    source.value = null;
    const result = await page.run(() =>
      memorySource(companionId.value, epoch.value, messageId, version),
    );
    if (token === generation) {
      source.value = result;
      if (!result) clear();
    }
  }
  watch(
    [companionId, conversationId, epoch],
    () => {
      generation++;
      selected.value = null;
      memoryAfter.value = undefined;
      clear();
      void refresh();
    },
    { immediate: true },
  );
  const timer = setInterval(() => {
    if (!document.hidden && !page.loading.value && !page.saving.value) void refresh();
  }, 5000);
  onScopeDispose(() => {
    disposed = true;
    generation++;
    clearInterval(timer);
  });
  return {
    ...page,
    items,
    detail,
    source,
    next,
    refresh,
    more,
    inspect,
    moreVersions,
    moreEvidence,
    memoryAfter,
    first,
    showSource,
  };
}
