import { computed, onScopeDispose, ref, watch } from 'vue';
import type { Ref } from 'vue';
import { useRouter } from 'vue-router';
import { MEMORY_EXPLORER_LIMITS } from '@memory-weave/contracts';
import type {
  CompanionDetail,
  MemoryDetail,
  MemoryEvidencePage,
  MemoryExplorerConversation,
  MemoryExplorerItem,
  MemoryExplorerQuery,
  MemoryExplorerScope,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryGraphQuery,
  MemoryReadReference,
  PublishedMessage,
} from '@memory-weave/contracts';
import {
  getExplorerCompanion,
  getMemoryGraph,
  listExplorerConversations,
  listMemoryExplorer,
  validateMemoryExplorer,
} from '@memory-weave/browser-client/memory-explorer';
import { getMemory, getMemoryEvidence, memorySource } from '@memory-weave/browser-client/memories';
import { ApiError } from '@memory-weave/browser-client/http';
import { useAuthStore } from '@/stores/auth';

/** 管理端记忆浏览；所有视图共用范围与失效处理，拒绝旧请求重新填回已清除正文。 */
export function useMemoryExplorer(
  companionId: Ref<string>,
  epoch: Ref<number>,
  initialConversation: Ref<string | undefined>,
) {
  const router = useRouter();
  const auth = useAuthStore();
  const companion = ref<CompanionDetail | null>(null);
  const conversations = ref<MemoryExplorerConversation[]>([]);
  const conversationsNext = ref<string | null>(null);
  const view = ref<'entries' | 'timeline' | 'graph'>('entries');
  const filters = ref<Partial<MemoryExplorerQuery>>({});
  const items = ref<MemoryExplorerItem[]>([]);
  const next = ref<string | null>(null);
  const selected = ref<MemoryExplorerItem | null>(null);
  const detail = ref<MemoryDetail | null>(null);
  const evidence = ref<MemoryEvidencePage | null>(null);
  const source = ref<PublishedMessage | null>(null);
  const graphNodes = ref<MemoryGraphNode[]>([]);
  const graphEdges = ref<MemoryGraphEdge[]>([]);
  const graphPages = ref<Record<string, MemoryGraphQuery>>({});
  const graphCenter = ref('');
  const loading = ref(false);
  const error = ref<string | null>(null);
  const notice = ref<string | null>(null);
  const suspended = ref(document.hidden);
  const graphLimit = ref(false);
  const scope = computed<MemoryExplorerScope>(() => ({
    runtimeEpoch: epoch.value,
    conversationId: filters.value.conversationId,
  }));
  let generation = 0;
  let action = 0;
  let disposed = false;
  let polling = false;
  let stale = false;
  let needsRefresh = true;

  /** 当前画面的依赖以版本去重，来源节点受引用它的版本状态约束。 */
  function references(extra: MemoryReadReference[] = []): MemoryReadReference[] {
    const records = [
      ...items.value,
      ...(selected.value ? [selected.value] : []),
      ...graphNodes.value.flatMap((node) => (node.record ? [node.record] : [])),
    ];
    const refs = [
      ...records.map((record) => ({ versionId: record.versionId, stamp: record.readStamp })),
      ...extra,
    ];
    const map = new Map<string, MemoryReadReference>();
    for (const reference of refs) {
      const previous = map.get(reference.versionId);
      if (previous && previous.stamp !== reference.stamp) throw new Error('画面版本已变化');
      map.set(reference.versionId, reference);
    }
    return [...map.values()];
  }
  /** 清除列表、正文、精确引文和画布，保留筛选条件方便重新读取。 */
  function clearContent(): void {
    items.value = [];
    next.value = null;
    selected.value = null;
    detail.value = null;
    evidence.value = null;
    source.value = null;
    graphNodes.value = [];
    graphEdges.value = [];
    graphPages.value = {};
    graphCenter.value = '';
    graphLimit.value = false;
  }
  /** 失效同时递增世代，任何仍在途的请求都不能恢复旧画面。 */
  function invalidate(message: string): void {
    generation++;
    action++;
    loading.value = false;
    stale = true;
    clearContent();
    notice.value = message;
  }
  /** 网络失败时也停止展示旧正文；认证失败返回当前端的登录页。 */
  async function fail(cause: unknown): Promise<void> {
    invalidate('内容暂不可核对，已清除旧画面。可稍后刷新。');
    error.value = cause instanceof ApiError ? cause.message : '读取未完成，请稍后重试。';
    if (cause instanceof ApiError && cause.status === 401) {
      auth.invalidateSession();
      await router.replace({ name: 'login' });
    }
  }
  /** 每次采用新数据前再次核对全部画面引用，覆盖响应返回途中的删除和范围切换。 */
  async function run<T>(
    operation: () => Promise<T>,
    refs: (result: T) => MemoryReadReference[],
    apply: (result: T) => void,
  ): Promise<void> {
    const token = generation;
    const request = ++action;
    const id = companionId.value;
    const range = { ...scope.value };
    loading.value = true;
    error.value = null;
    try {
      const result = await operation();
      if (disposed || token !== generation || request !== action || document.hidden) return;
      const validation = await validateMemoryExplorer(id, {
        ...range,
        references: references(refs(result)),
      });
      if (disposed || token !== generation || request !== action || document.hidden) return;
      if (!validation.valid) {
        invalidate('记忆或来源已变化，已清除旧画面，请刷新后继续。');
        return;
      }
      apply(result);
      stale = false;
      suspended.value = false;
    } catch (cause: unknown) {
      if (!disposed && token === generation && request === action) await fail(cause);
    } finally {
      if (token === generation && request === action) loading.value = false;
    }
  }
  /** 重读第一页，新增记录只在刷新后加入，图谱重新选择中心。 */
  async function refresh(cursor?: string): Promise<void> {
    if (disposed) return;
    if (!companion.value) {
      await initialize();
      return;
    }
    needsRefresh = true;
    generation++;
    action++;
    clearContent();
    notice.value = null;
    stale = false;
    if (view.value === 'graph') view.value = 'entries';
    const query: MemoryExplorerQuery = {
      ...filters.value,
      ...scope.value,
      limit: MEMORY_EXPLORER_LIMITS.pageSize,
      cursor,
    };
    await run(
      () =>
        listMemoryExplorer(
          companionId.value,
          query,
          view.value === 'timeline' ? 'timeline' : 'entries',
        ),
      (result) =>
        result.items.map((record) => ({ versionId: record.versionId, stamp: record.readStamp })),
      (result) => {
        items.value = result.items;
        next.value = result.nextCursor;
        needsRefresh = false;
      },
    );
  }
  /** 筛选改变使旧游标失效，后端不会将旧游标解释为新查询的继续位置。 */
  async function applyFilters(value: Partial<MemoryExplorerQuery>): Promise<void> {
    filters.value = value;
    await refresh();
  }
  /** 视图切换复用筛选；图谱需要先选择一个有实际记录的中心。 */
  async function changeView(value: 'entries' | 'timeline' | 'graph'): Promise<void> {
    if (value === 'graph') {
      if (selected.value) await showGraph(selected.value);
      else {
        view.value = value;
        notice.value = '请先从列表或时间线选择一条记忆进入图谱。';
      }
      return;
    }
    view.value = value;
    await refresh();
  }
  /** 详情同时读取确切版本证据；即使历史很多，也无需先翻完全部版本。 */
  async function inspect(record: MemoryExplorerItem): Promise<void> {
    selected.value = null;
    detail.value = null;
    evidence.value = null;
    source.value = null;
    const query = { runtimeEpoch: epoch.value, conversationId: record.conversationId, limit: 20 };
    await run(
      () =>
        Promise.all([
          getMemory(companionId.value, record.id, query),
          getMemoryEvidence(companionId.value, record.id, record.versionId, query),
        ]),
      () => [{ versionId: record.versionId, stamp: record.readStamp }],
      ([history, quotes]) => {
        selected.value = record;
        detail.value = history;
        evidence.value = quotes;
      },
    );
  }
  /** 历史每次替换一页，页面不会积累全部版本。 */
  async function moreVersions(): Promise<void> {
    const record = selected.value;
    if (!record || !detail.value?.nextAfterId) return;
    const query = {
      runtimeEpoch: epoch.value,
      conversationId: record.conversationId,
      limit: 20,
      afterId: detail.value.nextAfterId,
    };
    await run(
      () => getMemory(companionId.value, record.id, query),
      () => [],
      (result) => {
        detail.value = result;
      },
    );
  }
  /** 精确引文也独立分页，原文不复制进浏览器持久存储。 */
  async function moreEvidence(): Promise<void> {
    const record = selected.value;
    if (!record || !evidence.value?.nextAfterId) return;
    const query = {
      runtimeEpoch: epoch.value,
      conversationId: record.conversationId,
      limit: 20,
      afterId: evidence.value.nextAfterId,
    };
    await run(
      () => getMemoryEvidence(companionId.value, record.id, record.versionId, query),
      () => [],
      (result) => {
        evidence.value = result;
        source.value = null;
      },
    );
  }
  /** 原文回查经过现有权限接口，失败时不保留之前展开的原文。 */
  async function showSource(messageId: string, contentVersion: number): Promise<void> {
    source.value = null;
    await run(
      () => memorySource(companionId.value, epoch.value, messageId, contentVersion),
      () => [],
      (result) => {
        source.value = result;
      },
    );
  }
  /** 从列表或历史记录建立新的局部图，不把旧图与新中心的快照混为一轮。 */
  async function showGraph(
    record: MemoryExplorerItem,
    kind: 'memory' | 'version' = 'memory',
  ): Promise<void> {
    selected.value = record;
    detail.value = null;
    evidence.value = null;
    source.value = null;
    graphNodes.value = [];
    graphEdges.value = [];
    graphPages.value = {};
    graphLimit.value = false;
    notice.value = null;
    view.value = 'graph';
    const id = kind === 'memory' ? record.id : record.versionId;
    graphCenter.value = `${kind}:${id}`;
    await expandGraph({
      ...scope.value,
      centerKind: kind,
      centerId: id,
      limit: MEMORY_EXPLORER_LIMITS.graphPageSize,
    });
  }
  /** 合并一批真实关系，达到画布上限后保留已验证部分并提示重新选择中心。 */
  async function expandGraph(query: MemoryGraphQuery): Promise<void> {
    await run(
      () => getMemoryGraph(companionId.value, query),
      (result) =>
        result.nodes.flatMap((node) =>
          node.record ? [{ versionId: node.record.versionId, stamp: node.record.readStamp }] : [],
        ),
      (result) => {
        const nodes = [
          ...new Map(
            [...graphNodes.value, ...result.nodes].map((node) => [node.id, node]),
          ).values(),
        ];
        const edges = [
          ...new Map(
            [...graphEdges.value, ...result.edges].map((edge) => [edge.id, edge]),
          ).values(),
        ];
        if (
          nodes.length > MEMORY_EXPLORER_LIMITS.maxCanvasNodes ||
          edges.length > MEMORY_EXPLORER_LIMITS.maxCanvasEdges
        ) {
          graphLimit.value = true;
          notice.value = '当前画布已达到展示上限，请重新选择中心。';
          return;
        }
        graphNodes.value = nodes;
        graphEdges.value = edges;
        const pages = { ...graphPages.value };
        if (result.nextCursor) pages[result.center] = { ...query, cursor: result.nextCursor };
        else delete pages[result.center];
        graphPages.value = pages;
      },
    );
  }
  /** 直接定位某个历史版本，不需要先遍历全部版本页。 */
  async function showVersion(versionId: string): Promise<void> {
    const token = generation;
    view.value = 'graph';
    graphNodes.value = [];
    graphEdges.value = [];
    graphPages.value = {};
    graphLimit.value = false;
    detail.value = null;
    evidence.value = null;
    source.value = null;
    graphCenter.value = `version:${versionId}`;
    await expandGraph({
      ...scope.value,
      centerKind: 'version',
      centerId: versionId,
      limit: MEMORY_EXPLORER_LIMITS.graphPageSize,
    });
    if (token === generation)
      selected.value =
        graphNodes.value.find((node) => node.id === `version:${versionId}`)?.record ?? null;
  }
  /** 原文节点打开来源；记忆和版本节点只展开一层。 */
  async function selectNode(node: MemoryGraphNode): Promise<void> {
    if (node.kind === 'message' && node.messageId && node.contentVersion) {
      await showSource(node.messageId, node.contentVersion);
      return;
    }
    if (!node.record || node.kind === 'message') return;
    selected.value = node.record;
    detail.value = null;
    evidence.value = null;
    source.value = null;
    await expandGraph({
      ...scope.value,
      centerKind: node.kind,
      centerId: node.kind === 'memory' ? node.record.id : node.record.versionId,
      limit: MEMORY_EXPLORER_LIMITS.graphPageSize,
    });
  }
  /** 会话选择器替换当前页，避免长时间使用后累积全部会话。 */
  async function loadConversations(afterId?: string): Promise<void> {
    await run(
      () =>
        listExplorerConversations(companionId.value, {
          runtimeEpoch: epoch.value,
          limit: 50,
          afterId,
        }),
      () => [],
      (result) => {
        conversations.value = result.items;
        conversationsNext.value = result.nextAfterId;
      },
    );
  }
  /** 轮询仅核对已加载的引用，不重读全部正文、模型或图谱。 */
  async function validateVisible(): Promise<void> {
    if (disposed || polling || document.hidden || stale) return;
    const token = generation;
    polling = true;
    try {
      const result = await validateMemoryExplorer(companionId.value, {
        ...scope.value,
        references: references(),
      });
      if (disposed || token !== generation) return;
      if (!result.valid) invalidate('记忆或来源已变化，已清除旧画面，请刷新后继续。');
      else suspended.value = false;
    } catch (cause: unknown) {
      if (!disposed && token === generation) await fail(cause);
    } finally {
      polling = false;
    }
  }
  /** 后台标签页重新可见前先核对，隐藏期间的迟到读取全部丢弃。 */
  function visibility(): void {
    if (document.hidden) {
      suspended.value = true;
      generation++;
      action++;
      loading.value = false;
    } else if (!stale) {
      if (!companion.value) void initialize();
      else if (needsRefresh) void refresh();
      else void validateVisible();
    }
  }
  /** 离线后不能继续展示无法核对的来源。 */
  function offline(): void {
    invalidate('连接已断开，已清除旧画面。恢复连接后请刷新。');
  }
  /** 首次读取在后台被丢弃时，重新可见后从元信息开始恢复。 */
  async function initialize(): Promise<void> {
    const token = generation;
    await run(
      () =>
        Promise.all([
          getExplorerCompanion(companionId.value),
          listExplorerConversations(companionId.value, { runtimeEpoch: epoch.value, limit: 50 }),
        ]),
      () => [],
      ([identity, list]) => {
        companion.value = identity;
        conversations.value = list.items;
        conversationsNext.value = list.nextAfterId;
      },
    );
    if (token === generation && companion.value) await refresh();
  }
  watch(
    [companionId, epoch, initialConversation],
    async () => {
      generation++;
      action++;
      clearContent();
      companion.value = null;
      conversations.value = [];
      conversationsNext.value = null;
      filters.value = { conversationId: initialConversation.value };
      stale = false;
      error.value = null;
      notice.value = null;
      needsRefresh = true;
      await initialize();
    },
    { immediate: true },
  );
  const timer = setInterval(() => {
    void validateVisible();
  }, MEMORY_EXPLORER_LIMITS.pollMs);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('offline', offline);
  onScopeDispose(() => {
    disposed = true;
    generation++;
    action++;
    clearContent();
    clearInterval(timer);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('offline', offline);
  });
  return {
    companion,
    conversations,
    conversationsNext,
    view,
    filters,
    items,
    next,
    selected,
    detail,
    evidence,
    source,
    graphNodes,
    graphEdges,
    graphPages,
    graphCenter,
    graphLimit,
    loading,
    error,
    notice,
    suspended,
    refresh,
    applyFilters,
    changeView,
    inspect,
    moreVersions,
    moreEvidence,
    showSource,
    showGraph,
    showVersion,
    selectNode,
    expandGraph,
    loadConversations,
  };
}
