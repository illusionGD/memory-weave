import {
  memoryEvidencePageSchema,
  memoryBatchListSchema,
  memoryBatchResultSchema,
  memoryDetailSchema,
  memoryListSchema,
  publishedMessageSchema,
} from '@memory-weave/contracts';
import type {
  MemoryEvidencePage,
  MemoryBatchList,
  MemoryBatchResult,
  MemoryDetail,
  MemoryList,
  MemoryQuery,
  OrganizeMemory,
  PublishedMessage,
} from '@memory-weave/contracts';
import { requestJson } from './http';

/** 将实例与会话范围固定到每次请求，不自动改用新代次。 */
function queryString(query: MemoryQuery): string {
  const params = new URLSearchParams({
    runtimeEpoch: String(query.runtimeEpoch),
    conversationId: query.conversationId,
    limit: String(query.limit),
  });
  if (query.afterId) params.set('afterId', query.afterId);
  return params.toString();
}
/** 查询当前记忆分页。 */
export function listMemories(id: string, query: MemoryQuery): Promise<MemoryList> {
  return requestJson(`/api/companions/${id}/memories?${queryString(query)}`, memoryListSchema);
}
/** 查询独立整理批次。 */
export function listMemoryBatches(id: string, query: MemoryQuery): Promise<MemoryBatchList> {
  return requestJson(
    `/api/companions/${id}/memories/batches?${queryString(query)}`,
    memoryBatchListSchema,
  );
}
/** 查看不可变语义版本和精确证据。 */
export function getMemory(id: string, memoryId: string, query: MemoryQuery): Promise<MemoryDetail> {
  return requestJson(
    `/api/companions/${id}/memories/${memoryId}?${queryString(query)}`,
    memoryDetailSchema,
  );
}
/** 提前唤醒或明确重试已知失败的批次，网络重试沿用 requestId。 */
export function organizeMemory(
  id: string,
  input: OrganizeMemory,
  retryId?: string,
): Promise<MemoryBatchResult> {
  return requestJson(
    `/api/companions/${id}/memories/${retryId ? `batches/${retryId}/retry` : 'organize'}`,
    memoryBatchResultSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}
/** 回查完整原文；来源已删除或代次变化时服务端拒绝读取。 */
export function memorySource(
  id: string,
  epoch: number,
  messageId: string,
  version: number,
): Promise<PublishedMessage> {
  return requestJson(
    `/api/companions/${id}/sources/${messageId}?runtimeEpoch=${epoch}&contentVersion=${version}`,
    publishedMessageSchema,
  );
}

/** 单个版本的后续证据，避免一次拉取全部重复来源。 */
export function getMemoryEvidence(
  id: string,
  memoryId: string,
  versionId: string,
  query: MemoryQuery,
): Promise<MemoryEvidencePage> {
  return requestJson(
    `/api/companions/${id}/memories/${memoryId}/versions/${versionId}/evidence?${queryString(query)}`,
    memoryEvidencePageSchema,
  );
}
