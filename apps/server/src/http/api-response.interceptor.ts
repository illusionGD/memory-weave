import { API_CODES, API_RESPONSES, getApiResponseDefinition } from '@memory-weave/contracts';
import type { ApiResponse } from '@memory-weave/contracts';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { map } from 'rxjs';
import type { Observable } from 'rxjs';
import { ApiException } from './api-exception';

/** 成功响应的可选覆盖项，省略的字段继续使用共享默认值。 */
export interface ApiResultOptions {
  /** 常用码或未登记的业务自定义数字码。 */
  code?: number;
  /** 可展示的业务提示，允许覆盖常用码的默认文案。 */
  message?: string;
}

/** 控制器按需声明自定义响应；普通领域对象不需要包裹此类型。 */
export class ApiResult<T> {
  /**
   * 保存业务数据及响应覆盖项，由统一拦截器完成包装。
   * @param data 本接口的业务数据，无数据时使用 null。
   * @param options 可选的数字码和提示覆盖项。
   */
  constructor(
    readonly data: T,
    readonly options: ApiResultOptions = {},
  ) {}
}

/** 控制器返回领域数据，HTTP 出口统一包装一次；静态页面不经过此拦截器。 */
export class ApiResponseInterceptor implements NestInterceptor<unknown, ApiResponse> {
  /**
   * 将 JSON 接口的成功结果包装为公共协议；失败继续交给异常过滤器。
   * @param context 当前 HTTP 执行上下文。
   * @param next 控制器的领域结果。
   * @returns 带数字响应码、业务数据和安全提示的统一响应。
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<ApiResponse> {
    const response = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      map((value: unknown) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw new ApiException(API_CODES.INTERNAL_ERROR);
        }
        const result = value instanceof ApiResult ? value : new ApiResult(value);
        const code = result.options.code ?? response.statusCode;
        const message =
          result.options.message ??
          getApiResponseDefinition(code)?.message ??
          getApiResponseDefinition(response.statusCode)?.message ??
          API_RESPONSES[API_CODES.OK].message;
        return { code, data: result.data ?? null, message };
      }),
    );
  }
}
