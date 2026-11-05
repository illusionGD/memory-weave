import { randomUUID } from 'node:crypto';
import { Catch, HttpException } from '@nestjs/common';
import { DrizzleQueryError } from 'drizzle-orm';
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
   * 创建包含业务响应码和提示信息的异常。
   *
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

/**
 * 为 HTTP 请求分配追踪编号。
 *
 * 每次请求生成新的追踪编号，不接受客户端伪造或复用服务端日志标识。
 */
export const assignRequestId: RequestHandler = (_request, response, next): void => {
  response.setHeader(REQUEST_ID_HEADER, randomUUID());
  next();
};

/**
 * 发送统一格式的 API 错误响应。
 *
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
   * 将捕获的异常转换为统一错误响应。
   *
   * 分类异常并交给统一出口，中间件错误可直接复用同一输出函数。
   * @param exception 业务或框架抛出的未知值。
   * @param host 当前 HTTP 请求上下文。
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof DrizzleQueryError) exception = normalizeDatabaseError(exception);
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

/** 在数据库执行边界转换错误，供普通操作和事务共用。 */
export async function databaseOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw normalizeDatabaseError(error);
  }
}
/** 统一分类驱动、业务与程序异常，避免返回底层诊断。 */
export function normalizeDatabaseError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  const code = databaseErrorCode(error);
  if (code === 'ER_DUP_ENTRY') return new ApiException(API_CODES.CONFLICT);
  if (
    [
      'ER_NO_REFERENCED_ROW_2',
      'ER_ROW_IS_REFERENCED_2',
      'ER_CHECK_CONSTRAINT_VIOLATED',
      'ER_BAD_NULL_ERROR',
      'ER_DATA_TOO_LONG',
      'WARN_DATA_OUT_OF_RANGE',
      'ER_TRUNCATED_WRONG_VALUE',
      'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
    ].includes(code ?? '')
  ) {
    return new ApiException(API_CODES.DATA_CONSTRAINT_VIOLATION);
  }
  if (code) return new ApiException(API_CODES.DATA_UNAVAILABLE);
  // 无法识别为数据库错误的异常交给全局 500 处理，避免掩盖业务代码缺陷。
  return error;
}

/**
 * 从数据库异常及其原因中提取错误代码。
 *
 * Drizzle 会把驱动异常放在 cause 中，只提取受控分类所需的错误代码。
 */
function databaseErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object') return undefined;
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}
