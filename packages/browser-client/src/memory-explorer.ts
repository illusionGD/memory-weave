import {
  companionDetailSchema,
  memoryExplorerPageSchema,
  memoryGraphPageSchema,
  memoryExplorerValidationResultSchema,
  memoryExplorerConversationsSchema,
} from '@memory-weave/contracts';
import type {
  CompanionDetail,
  MemoryExplorerPage,
  MemoryExplorerQuery,
  MemoryGraphPage,
  MemoryGraphQuery,
  MemoryExplorerValidation,
  MemoryExplorerValidationResult,
  MemoryExplorerConversations,
  MemoryExplorerConversationsQuery,
} from '@memory-weave/contracts';
import { requestJson } from './http';

/** 将已校验范围转换成查询参数，省略未设置项。 */
function parameters(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, String(value));
  return params.toString();
}
/** 读取伴侣当前身份；不会把查询携带的旧代次自动升级。 */
export function getExplorerCompanion(id: string): Promise<CompanionDetail> {
  return requestJson(`/api/companions/${id}`, companionDetailSchema);
}
/** 当前列表和版本时间线共享筛选含义，分页游标不能跨视图复用。 */
export function listMemoryExplorer(
  id: string,
  query: MemoryExplorerQuery,
  view: 'entries' | 'timeline' = 'entries',
): Promise<MemoryExplorerPage> {
  return requestJson(
    `/api/companions/${id}/memory-explorer/${view}?${parameters(query)}`,
    memoryExplorerPageSchema,
  );
}
/** 按中心读取一页实际关系，不请求无限展开。 */
export function getMemoryGraph(id: string, query: MemoryGraphQuery): Promise<MemoryGraphPage> {
  return requestJson(
    `/api/companions/${id}/memory-explorer/graph?${parameters(query)}`,
    memoryGraphPageSchema,
  );
}
/** 校验已经展示的记录，false 时调用方必须清除旧缓存。 */
export function validateMemoryExplorer(
  id: string,
  input: MemoryExplorerValidation,
): Promise<MemoryExplorerValidationResult> {
  return requestJson(
    `/api/companions/${id}/memory-explorer/validate`,
    memoryExplorerValidationResultSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}
/** 选择器也使用有界分页，不先下载全部会话。 */
export function listExplorerConversations(
  id: string,
  query: MemoryExplorerConversationsQuery,
): Promise<MemoryExplorerConversations> {
  return requestJson(
    `/api/companions/${id}/memory-explorer/conversations?${parameters(query)}`,
    memoryExplorerConversationsSchema,
  );
}
