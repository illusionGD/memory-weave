import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { loginRequestSchema } from '@memory-weave/contracts';
import type { SessionResponse } from '@memory-weave/contracts';
import { SERVER_CONFIG } from '../../config';
import type { RuntimeConfig } from '../../config';
import { AuthService, SESSION_LIFETIME_MS } from './auth.service';
import { PublicRoute } from './public-route';
import { readSessionCookie, SESSION_COOKIE_NAME, sessionCookieOptions } from './session-cookie';
import { ApiException } from '../../http/api-exception';
import { parseInput } from '../shared/http';

/** 提供 HTTP 认证接口，未显式标记公开的路由均受默认守卫保护。 */
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SERVER_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  /**
   * 验证部署密码，为浏览器建立由服务端管理的会话。
   * @param body 尚未校验的 JSON 请求体。
   * @param request 包含底层连接来源地址的请求。
   * @param response 用于设置会话 Cookie 的 HTTP 响应。
   * @returns 不包含凭据的会话确认信息。
   */
  @PublicRoute()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionResponse> {
    const input = parseInput(loginRequestSchema, body);
    this.auth.checkLoginRate(request.ip ?? 'unknown');
    if (!(await this.auth.verifyPassword(input.password))) {
      throw new ApiException('INVALID_CREDENTIALS');
    }
    const token = this.auth.createSession();
    response.cookie(SESSION_COOKIE_NAME, token, {
      ...sessionCookieOptions(this.config.cookieSecure),
      maxAge: SESSION_LIFETIME_MS,
    });
    return { authenticated: true };
  }

  /**
   * 确认当前会话已通过全局认证守卫的校验。
   * @returns 已认证的会话状态。
   */
  @Get('session')
  session(): SessionResponse {
    return { authenticated: true };
  }

  /**
   * 先撤销服务端会话，再清除浏览器中的 Cookie。
   * @param request 携带会话 Cookie 且已通过认证的请求。
   * @param response 用于清除 Cookie 的 HTTP 响应。
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): void {
    this.auth.revokeSession(readSessionCookie(request));
    response.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions(this.config.cookieSecure));
  }
}
