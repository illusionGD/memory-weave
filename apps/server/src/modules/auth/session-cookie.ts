import type { Request, CookieOptions } from 'express';

/** Browser session cookie name; its value is never returned in a JSON response. */
export const SESSION_COOKIE_NAME = 'memory_weave_session';

/**
 * Reads one untrusted cookie without assuming a parsed shape from Express.
 * @param request Incoming HTTP request.
 * @returns A string token or null when absent/malformed.
 */
export function readSessionCookie(request: Request): string | null {
  const cookies: unknown = request.cookies;
  if (!cookies || typeof cookies !== 'object') return null;
  const token = (cookies as Record<string, unknown>)[SESSION_COOKIE_NAME];
  return typeof token === 'string' ? token : null;
}

/**
 * Uses identical scope when creating and clearing a cookie.
 * @param secure Whether the deployment uses HTTPS.
 * @returns Cookie security and path options.
 */
export function sessionCookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, sameSite: 'strict', secure, path: '/' };
}
