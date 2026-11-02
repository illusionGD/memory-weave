import { API_CODES } from '@memory-weave/contracts';
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { ServerConfig } from '../../config';
import { RedisAuthStore } from './redis-auth-store';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import { ApiException } from '../../http/api-exception';
import type { OnModuleDestroy } from '@nestjs/common';

const deriveKey = promisify(scrypt);

/** Cookie 会话固定有效 12 小时，访问或进程重启不延长有效期。 */
export const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

/** 校验单用户部署密码并管理可跨进程使用的登录会话。 */
@Injectable()
export class AuthService implements OnModuleDestroy {
  /** 初始化密码校验数据和登录限制。 */
  private constructor(
    private readonly salt: Buffer,
    private readonly passwordHash: Buffer,
    private readonly store: RedisAuthStore,
    readonly sessionLifetimeMs: number,
  ) {}

  /**
   * 创建密码校验所需的认证服务。
   *
   * 初始化密码校验信息，不保留传入的明文密码。
   * @param password 部署时配置的初始密码。
   * @param config 稳定的认证存储配置，以及程序化验收可缩短的有效期。
   * @returns 可用于校验登录的认证服务。
   */
  static async create(
    password: string,
    config: Pick<
      ServerConfig,
      'redisUrl' | 'redisNamespace' | 'authSessionSecret' | 'authSessionLifetimeMs'
    >,
  ): Promise<AuthService> {
    const salt = randomBytes(32);
    const lifetimeMs = config.authSessionLifetimeMs ?? SESSION_LIFETIME_MS;
    if (!Number.isInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > SESSION_LIFETIME_MS)
      throw new Error('会话有效期必须为不超过 12 小时的正整数毫秒。');
    const hash = (await deriveKey(password, salt, 64)) as Buffer;
    const credentialVersion = createHmac('sha256', config.authSessionSecret)
      .update(password)
      .digest('hex');
    const store = new RedisAuthStore(config.redisUrl, config.redisNamespace, credentialVersion);
    return new AuthService(salt, hash, store, lifetimeMs);
  }

  /**
   * 校验输入密码是否匹配部署密码。
   *
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
   * 检查并记录当前来源的登录频率。
   *
   * 在执行开销较大的密码哈希前，按来源和时间窗口限制登录次数及来源记录数量。
   * @param source 根据底层连接取得的客户端标识，不信任转发请求头。
   */
  async checkLoginRate(source: string): Promise<void> {
    if (!(await this.store.allowLogin(this.digest(source))))
      throw new ApiException(API_CODES.RATE_LIMITED);
  }

  /**
   * 创建登录会话及其访问令牌。
   *
   * 创建随机会话令牌，服务端仅保存令牌摘要。
   * @returns 仅通过 HttpOnly Cookie 发送给浏览器的会话令牌。
   */
  async createSession(): Promise<string> {
    const token = randomBytes(32).toString('hex');
    await this.store.createSession(this.digest(token), this.sessionLifetimeMs);
    return token;
  }

  /**
   * 判断会话令牌是否有效且尚未过期。
   *
   * 通过服务端记录和过期时间校验会话，不信任客户端声明的状态。
   * @param token 尚未校验的 Cookie 值。
   * @returns 令牌是否对应有效会话。
   */
  async hasSession(token: string | null): Promise<boolean> {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
    return this.store.hasSession(this.digest(token));
  }

  /**
   * 撤销指定令牌对应的登录会话。
   *
   * 撤销会话，使旧 Cookie 再次提交时无法通过认证。
   * @param token 会话 Cookie 的值，缺失时为 null。
   */
  async revokeSession(token: string | null): Promise<void> {
    if (token) await this.store.revokeSession(this.digest(token));
  }

  /**
   * 释放进程认证凭据和 Redis 连接。
   *
   * 关闭应用只清除进程内密码哈希，不删除 Redis 会话。
   */
  onModuleDestroy(): void {
    this.passwordHash.fill(0);
    this.store.close();
  }

  /** 计算会话令牌或可信连接来源的摘要。 */
  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * 检查 Redis 认证连接是否可访问。
   * @returns Redis 当前是否能够完成连接探测。
   */
  async isAvailable(): Promise<boolean> {
    return this.store.isAvailable();
  }
}
