import {
  lifecycleListSchema,
  lifecycleOperationSchema,
  conversationDetailSchema,
} from '@memory-weave/contracts';
import type {
  LifecycleCommand,
  LifecycleList,
  LifecycleOperation,
  RetryLifecycle,
  ConversationDetail,
} from '@memory-weave/contracts';
import { requestJson } from './http';

/** 将不含正文的命令交给同源管理接口。 */
function command(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
/** @param input 明确目标与所见版本。 @returns 已生效限制和清理进度。 */
export function createLifecycle(input: LifecycleCommand): Promise<LifecycleOperation> {
  return requestJson('/api/lifecycle', lifecycleOperationSchema, command(input));
}
/** @param id 操作身份。 @returns 持久清理进度。 */
export function getLifecycle(id: string): Promise<LifecycleOperation> {
  return requestJson(`/api/lifecycle/${encodeURIComponent(id)}`, lifecycleOperationSchema);
}
/** @param afterId 上页游标。 @returns 一页最小操作日志。 */
export function listLifecycle(afterId?: string): Promise<LifecycleList> {
  return requestJson(
    `/api/lifecycle${afterId ? `?afterId=${encodeURIComponent(afterId)}` : ''}`,
    lifecycleListSchema,
  );
}
/** @param id 原操作身份。 @param input 恢复命令身份。 @returns 沿用原清理进度的新任务。 */
export function retryLifecycle(id: string, input: RetryLifecycle): Promise<LifecycleOperation> {
  return requestJson(
    `/api/lifecycle/${encodeURIComponent(id)}/retry`,
    lifecycleOperationSchema,
    command(input),
  );
}
/** @param id 选中消息的会话身份。 @returns 删除命令所需的当前会话版本。 */
export function getLifecycleConversation(id: string): Promise<ConversationDetail> {
  return requestJson(`/api/conversations/${encodeURIComponent(id)}`, conversationDetailSchema);
}
