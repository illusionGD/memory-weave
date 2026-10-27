import { API_CODES } from '@memory-weave/contracts';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import { ApiException } from '../../http/api-exception';
import type { OnModuleDestroy } from '@nestjs/common';

const deriveKey = promisify(scrypt);

/** Cookie 会话的有效期为 12 小时，进程重启后失效。 */
export const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

const MAX_SESSIONS = 10;
const LOGIN_WINDOW_MS = 60_000;
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_LOGIN_SOURCES = 1024;

/** 单用户部署的初始认证服务；持久化用户身份由 F02 实现。 */
@Injectable()
export class AuthService implements OnModuleDestroy {
  private readonly sessions = new Map<string, number>();
  private readonly loginAttempts = new Map<string, { count: number; expiresAt: number }>();

  private constructor(
    private readonly salt: Buffer,
    private readonly passwordHash: Buffer,
  ) {}

  /**
   * 初始化密码校验信息，不保留传入的明文密码。
   * @param password 部署时配置的初始密码。
   * @returns 可用于校验登录的认证服务。
   */
  static async create(password: string): Promise<AuthService> {
    const salt = randomBytes(32);
    const hash = (await deriveKey(password, salt, 64)) as Buffer;
    return new AuthService(salt, hash);
  }

  /**
   * 派生密码密钥，并通过恒定时间比较检查是否匹配。
   * @param password 通过登录请求格式校验后取得的密码。
   * @returns 提交的密码是否正确。
   */
  async verifyPassword(password: string): Promise<boolean> {
    const candidate = (await deriveKey(password, this.salt, 64)) as Buffer;
    const valid = timingSafeEqual(candidate, this.passwordHash);
    candidate.fill(0);
    return valid;
  }

  /**
   * 在执行开销较大的密码哈希前，按来源和时间窗口限制登录次数及来源记录数量。
   * @param source 根据底层连接取得的客户端标识，不信任转发请求头。
   */
  checkLoginRate(source: string): void {
    const now = Date.now();
    for (const [key, entry] of this.loginAttempts) {
      if (entry.expiresAt <= now) this.loginAttempts.delete(key);
    }
    const entry = this.loginAttempts.get(source);
    if (entry) {
      if (entry.count >= MAX_LOGIN_ATTEMPTS) {
        throw new ApiException(API_CODES.RATE_LIMITED);
      }
      entry.count += 1;
      return;
    }
    if (this.loginAttempts.size >= MAX_LOGIN_SOURCES) {
      throw new ApiException(API_CODES.RATE_LIMITED);
    }
    this.loginAttempts.set(source, { count: 1, expiresAt: now + LOGIN_WINDOW_MS });
  }

  /**
   * 创建随机会话令牌，服务端仅保存令牌摘要。
   * @returns 仅通过 HttpOnly Cookie 发送给浏览器的会话令牌。
   */
  createSession(): string {
    this.removeExpiredSessions();
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (oldest) this.sessions.delete(oldest);
    }
    const token = randomBytes(32).toString('hex');
    this.sessions.set(this.digest(token), Date.now() + SESSION_LIFETIME_MS);
    return token;
  }

  /**
   * 通过服务端记录和过期时间校验会话，不信任客户端声明的状态。
   * @param token 尚未校验的 Cookie 值。
   * @returns 令牌是否对应有效会话。
   */
  hasSession(token: string | null): boolean {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
    const digest = this.digest(token);
    const expiresAt = this.sessions.get(digest);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.sessions.delete(digest);
      return false;
    }
    return true;
  }

  /**
   * 撤销会话，使旧 Cookie 再次提交时无法通过认证。
   * @param token 会话 Cookie 的值，缺失时为 null。
   */
  revokeSession(token: string | null): void {
    if (token) this.sessions.delete(this.digest(token));
  }

  /** 关闭应用时清除当前进程内的凭据和会话。 */
  onModuleDestroy(): void {
    this.passwordHash.fill(0);
    this.sessions.clear();
    this.loginAttempts.clear();
  }

  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private removeExpiredSessions(): void {
    const now = Date.now();
    for (const [digest, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(digest);
    }
  }
}
