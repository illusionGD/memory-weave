import {
  loginRequestSchema,
  sessionResponseSchema,
  type SessionResponse,
} from '@memory-weave/contracts';
import { request, requestJson } from './http';

/**
 * 查询当前浏览器的登录会话。
 *
 * 查询当前 Cookie 是否仍对应有效的服务端会话。
 * @returns 已认证会话；未登录时抛出 401 错误。
 */
export function getSession(): Promise<SessionResponse> {
  return requestJson('/api/auth/session', sessionResponseSchema);
}

/**
 * 提交部署密码并建立登录会话。
 * @param password 本次输入的密码，不在前端持久化。
 * @returns 服务端确认的登录状态。
 */
export function login(password: string): Promise<SessionResponse> {
  const body = loginRequestSchema.parse({ password });

  return requestJson('/api/auth/login', sessionResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * 撤销当前登录会话。
 *
 * 使服务端会话失效；仅清本地状态不构成退出成功。
 */
export async function logout(): Promise<void> {
  await request('/api/auth/logout', { method: 'POST' });
}
