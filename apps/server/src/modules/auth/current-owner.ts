import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { API_CODES } from '@memory-weave/contracts';
import { ApiException } from '../../http/api-exception';

/** 仅由认证守卫写入的服务端会话归属；不读取请求头、正文或查询参数。 */
export type AuthenticatedRequest = Request & { ownerId?: string };

/** 把认证后的 ownerId 显式传给控制器，不建立隐式异步上下文。 */
export const CurrentOwner = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const ownerId = context.switchToHttp().getRequest<AuthenticatedRequest>().ownerId;
    if (!ownerId) throw new ApiException(API_CODES.AUTH_REQUIRED);
    return ownerId;
  },
);
