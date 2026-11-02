import {
  workspaceResponseSchema,
  type UpdateWorkspaceRequest,
  type WorkspaceResponse,
} from '@memory-weave/contracts';
import { requestJson } from './http';

/**
 * 查询当前登录用户的资料。
 *
 * 读取当前已登录用户的资料，不在浏览器持久缓存。
 * @returns 当前工作区身份及显示名称。
 */
export function getWorkspace(): Promise<WorkspaceResponse> {
  return requestJson('/api/workspace', workspaceResponseSchema);
}

/**
 * 保存当前用户的显示名称。
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
