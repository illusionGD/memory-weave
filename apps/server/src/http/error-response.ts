import { randomUUID } from 'node:crypto';
import { API_ERRORS, REQUEST_ID_HEADER } from '@memory-weave/contracts';
import type { ApiErrorCode, ApiErrorResponse } from '@memory-weave/contracts';
import type { RequestHandler, Response } from 'express';

/** 每次请求生成新的追踪编号，不接受客户端伪造或复用服务端日志标识。 */
export const assignRequestId: RequestHandler = (_request, response, next): void => {
  response.setHeader(REQUEST_ID_HEADER, randomUUID());
  next();
};

/**
 * 中间件与异常过滤器共同使用的错误出口，只输出登记过的安全字段。
 * @param response 尚未发送的 HTTP 响应。
 * @param code 共享业务错误码。
 */
export function sendApiError(response: Response, code: ApiErrorCode): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const header = response.getHeader(REQUEST_ID_HEADER);
  const requestId = typeof header === 'string' ? header : randomUUID();
  const { statusCode, message } = API_ERRORS[code];
  const body: ApiErrorResponse = { statusCode, code, message, requestId };
  response.setHeader(REQUEST_ID_HEADER, requestId);
  response.setHeader('Cache-Control', 'no-store');
  // 只记录关联编号与受控分类；路径、查询、正文、Cookie、连接串和异常堆栈均不进入日志。
  console.error(JSON.stringify({ event: 'http.request.failed', requestId, statusCode, code }));
  response.status(statusCode).json(body);
}
