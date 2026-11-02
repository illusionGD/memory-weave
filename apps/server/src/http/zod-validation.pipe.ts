import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext, PipeTransform } from '@nestjs/common';
import type { Request } from 'express';
import type { z } from 'zod';
import { API_CODES } from '@memory-weave/contracts';
import { ApiException } from './api-exception';

/** 使用共享 Zod 契约校验并转换 NestJS 路由参数。 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  /**
   * 保存当前参数使用的校验规则。
   * @param schema 请求参数对应的共享契约。
   */
  constructor(private readonly schema: z.ZodType<T>) {}

  /**
   * 校验输入并返回应用转换和默认值后的参数。
   *
   * 校验失败统一返回公共错误，不回显请求正文或 Zod 错误细节。
   * @param value 尚未校验的请求参数。
   * @returns 通过校验并完成转换的参数。
   */
  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) throw new ApiException(API_CODES.INVALID_REQUEST);
    return result.data;
  }
}

/**
 * 提取指定请求头供 NestJS 参数管道校验。
 *
 * 原生 Headers 装饰器不接受管道参数，使用自定义参数装饰器接入同一校验流程。
 */
export const RequestHeader = createParamDecorator((name: string, context: ExecutionContext) =>
  context.switchToHttp().getRequest<Request>().get(name),
);
