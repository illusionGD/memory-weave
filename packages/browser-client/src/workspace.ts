import {
  workspaceResponseSchema,
  type UpdateWorkspaceRequest,
  type WorkspaceResponse,
} from '@memory-weave/contracts';
import { requestJson } from './http';

/**
 * 读取当前已登录用户的资料，不在浏览器持久缓存。
 * @returns 当前工作区身份及显示名称。
 */
export function getWorkspace(): Promise<WorkspaceResponse> {
  return requestJson('/api/workspace', workspaceResponseSchema);
}

/**
 * 更新用户显示名称，身份由当前登录会话决定。
 * @param input 经过公共契约验证的名称。
 * @returns 服务端实际保存后的工作区资料。
 */
export function updateWorkspace(input: UpdateWorkspaceRequest): Promise<WorkspaceResponse> {
  return requestJson('/api/workspace', workspaceResponseSchema, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}
