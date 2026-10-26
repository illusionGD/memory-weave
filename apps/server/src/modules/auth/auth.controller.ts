import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { loginRequestSchema } from '@memory-weave/contracts';
import type { SessionResponse } from '@memory-weave/contracts';
import { SERVER_CONFIG } from '../../config';
import type { RuntimeConfig } from '../../config';
import { AuthService, SESSION_LIFETIME_MS } from './auth.service';
import { PublicRoute } from './public-route';
import { readSessionCookie, SESSION_COOKIE_NAME, sessionCookieOptions } from './session-cookie';

/** HTTP authentication boundary; the default guard protects every unmarked route. */
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SERVER_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  /**
   * Exchanges the deployment password for a server-owned browser session.
   * @param body Untrusted JSON request body.
   * @param request Request carrying the socket-derived client address.
   * @param response HTTP response used only for setting the session cookie.
   * @returns A session acknowledgement without credential material.
   */
  @PublicRoute()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionResponse> {
    const parsed = loginRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid login request.');
    this.auth.checkLoginRate(request.ip ?? 'unknown');
    if (!(await this.auth.verifyPassword(parsed.data.password))) {
      throw new UnauthorizedException('Invalid credentials.');
    }
    const token = this.auth.createSession();
    response.cookie(SESSION_COOKIE_NAME, token, {
      ...sessionCookieOptions(this.config.cookieSecure),
      maxAge: SESSION_LIFETIME_MS,
    });
    return { authenticated: true };
  }

  /**
   * Confirms that the global guard accepted the current session.
   * @returns Authenticated session state.
   */
  @Get('session')
  session(): SessionResponse {
    return { authenticated: true };
  }

  /**
   * Revokes server state before clearing the browser's cookie.
   * @param request Authenticated request carrying the session cookie.
   * @param response HTTP response used to clear the cookie.
   */
  @Post('logout')
  @HttpCode(204)
  logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): void {
    this.auth.revokeSession(readSessionCookie(request));
    response.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions(this.config.cookieSecure));
  }
}
