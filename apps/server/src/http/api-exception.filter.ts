import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { API_ERROR_CODES, defaultApiErrorCode } from '@memory-weave/contracts';
import { ApiException } from './api-exception';
import { sendApiError } from './error-response';

/** 拦截业务、框架及未知异常，禁止将原始异常正文直接交给终端。 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  /**
   * 将异常分类为公共错误，未知异常固定使用安全的 500 响应。
   * @param exception 业务或框架抛出的未知值。
   * @param host 当前 HTTP 请求上下文。
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    const code =
      exception instanceof ApiException
        ? exception.code
        : exception instanceof HttpException
          ? defaultApiErrorCode(exception.getStatus())
          : API_ERROR_CODES.INTERNAL_ERROR;
    sendApiError(host.switchToHttp().getResponse<Response>(), code);
  }
}
