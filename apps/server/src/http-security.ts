import type { NextFunction, Request, Response } from 'express';
import type { RequestHandler } from 'express';

/**
 * 校验写请求的浏览器来源，防止其他站点借用会话发起操作。
 * @param allowedOrigin 配置中允许访问的浏览器来源，包含端口。
 * @returns 处理 API 请求的 Express 中间件。
 */
export function createOriginCheck(allowedOrigin: string): RequestHandler {
  return function checkOrigin(request: Request, response: Response, next: NextFunction): void {
    const path = request.path.toLowerCase();
    if (path === '/api' || path.startsWith('/api/')) {
      response.setHeader('Cache-Control', 'no-store');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        const origin = request.get('origin');
        if (origin !== undefined && origin !== allowedOrigin) {
          response.status(403).json({ statusCode: 403, message: 'Request origin is not allowed.' });
          return;
        }
      }
    }
    next();
  };
}

/**
 * 对请求体解析错误进行脱敏，避免将格式错误的凭据原文返回客户端。
 * @param error 请求体解析器或前置中间件产生的错误。
 * @param _request 请求上下文，不写入日志。
 * @param response 用于返回错误信息的 HTTP 响应。
 * @param next 将不属于本中间件处理范围的错误继续传递。
 */
export function handleBodyError(
  error: unknown,
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  const isTooLarge =
    !!error && typeof error === 'object' && 'status' in error && error.status === 413;
  if (isTooLarge || error instanceof SyntaxError) {
    const statusCode = isTooLarge ? 413 : 400;
    response.status(statusCode).json({
      statusCode,
      message: isTooLarge ? 'Request body is too large.' : 'Invalid JSON request.',
    });
    return;
  }
  next(error);
}
