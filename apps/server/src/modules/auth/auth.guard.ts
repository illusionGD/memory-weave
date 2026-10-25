import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';
import { PUBLIC_ROUTE } from './public-route.js';
import { readSessionCookie } from './session-cookie.js';

/** Routes are private unless explicitly declared public. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  /**
   * Rejects requests without a server-verified session.
   * @param context Route metadata and request context.
   * @returns Whether the request can access the route.
   */
  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest<Request>();
    if (this.auth.hasSession(readSessionCookie(request))) return true;
    throw new UnauthorizedException('Authentication required.');
  }
}
