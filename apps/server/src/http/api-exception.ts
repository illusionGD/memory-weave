import { randomUUID } from 'node:crypto';
import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import {
  API_CODES,
  API_RESPONSES,
  REQUEST_ID_HEADER,
  defaultApiErrorCode,
  getApiResponseDefinition,
} from '@memory-weave/contracts';
import type { ApiErrorResponse } from '@memory-weave/contracts';
import type { RequestHandler, Response } from 'express';

/** 可对外展示的业务异常；共享码表提供默认值，也允许业务自定义数字码和提示。 */
export class ApiException extends HttpException {
  /** 业务明确选择的数字响应码，不要求预先登记到共享码表。 */
  readonly code: number;

  /**
   * 声明可安全展示的业务失败，不能直接传入底层异常、凭据或请求原文。
   * @param code 共享常量或业务自定义的数字码。
   * @param message 可选的业务提示，优先于码表中的默认提示。
   * @param statusCode 可选的 HTTP 错误状态；未提供时使用码表，未登记的码默认 400。
   */
  constructor(code: number, message?: string, statusCode?: number) {
    const definition = getApiResponseDefinition(code);
    const status = statusCode ?? definition?.statusCode ?? 400;
    if (!Number.isFinite(code) || !Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError('业务异常需要数字响应码及 400～599 的 HTTP 状态。');
    }
    super(
      message ?? definition?.message ?? API_RESPONSES[defaultApiErrorCode(status)].message,
      status,
    );
    this.code = code;
  }
}

/** 每次请求生成新的追踪编号，不接受客户端伪造或复用服务端日志标识。 */
export const assignRequestId: RequestHandler = (_request, response, next): void => {
  response.setHeader(REQUEST_ID_HEADER, randomUUID());
  next();
};

/**
 * 中间件与异常过滤器共用同一个输出入口，不拼装不同格式的失败正文。
 * @param response 尚未发送的 HTTP 响应。
 * @param error 业务明确声明或全局过滤器归一化后的安全异常。
 */
export function sendApiError(response: Response, error: ApiException): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const header = response.getHeader(REQUEST_ID_HEADER);
  const requestId = typeof header === 'string' ? header : randomUUID();
  const statusCode = error.getStatus();
  const { code, message } = error;
  const body: ApiErrorResponse = { code, data: null, message };
  response.setHeader(REQUEST_ID_HEADER, requestId);
  response.setHeader('Cache-Control', 'no-store');
  // 不记录提示、请求、凭据或异常堆栈；自定义提示仅进入本次业务响应。
  console.error(JSON.stringify({ event: 'http.request.failed', requestId, statusCode, code }));
  response.status(statusCode).json(body);
}

/** 业务异常保留明确声明的提示；框架及未知异常统一转换，禁止泄露原始诊断内容。 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  /**
   * 分类异常并交给统一出口，中间件错误可直接复用同一输出函数。
   * @param exception 业务或框架抛出的未知值。
   * @param host 当前 HTTP 请求上下文。
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    const error =
      exception instanceof ApiException
        ? exception
        : new ApiException(
            exception instanceof HttpException
              ? defaultApiErrorCode(exception.getStatus())
              : API_CODES.INTERNAL_ERROR,
          );
    sendApiError(host.switchToHttp().getResponse<Response>(), error);
  }
}
