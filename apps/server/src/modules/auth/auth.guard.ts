import { API_ERROR_CODES } from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { PUBLIC_ROUTE } from './public-route';
import { readSessionCookie } from './session-cookie';
import { ApiException } from '../../http/api-exception';

/** 路由默认需要认证，只有显式标记为公开时才允许直接访问。 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  /**
   * 校验受保护路由的服务端会话，无有效会话时拒绝请求。
   * @param context 路由元数据与请求上下文。
   * @returns 请求是否可以访问目标路由。
   */
  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest<Request>();
    if (this.auth.hasSession(readSessionCookie(request))) return true;
    throw new ApiException(API_ERROR_CODES.AUTH_REQUIRED);
  }
}
