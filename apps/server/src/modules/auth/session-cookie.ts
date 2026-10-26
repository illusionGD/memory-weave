import type { Request, CookieOptions } from 'express';

/** 浏览器会话 Cookie 的名称，其值不会通过 JSON 响应返回。 */
export const SESSION_COOKIE_NAME = 'memory_weave_session';

/**
 * 从请求中读取会话 Cookie，并检查 Express 解析结果的类型。
 * @param request 收到的 HTTP 请求。
 * @returns 字符串形式的令牌；值缺失或类型不正确时返回 null。
 */
export function readSessionCookie(request: Request): string | null {
  const cookies: unknown = request.cookies;
  if (!cookies || typeof cookies !== 'object') return null;
  const token = (cookies as Record<string, unknown>)[SESSION_COOKIE_NAME];
  return typeof token === 'string' ? token : null;
}

/**
 * 创建与清除 Cookie 时使用相同的作用范围和安全选项。
 * @param secure 当前部署是否使用 HTTPS。
 * @returns Cookie 的安全属性与路径配置。
 */
export function sessionCookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, sameSite: 'strict', secure, path: '/' };
}
