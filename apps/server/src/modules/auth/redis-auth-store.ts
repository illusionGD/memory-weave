import { createClient } from 'redis';
import { API_CODES } from '@memory-weave/contracts';
import { ApiException } from '../../http/api-exception';

const COMMAND_TIMEOUT_MS = 1500;
const MAX_SESSIONS = 10;
const LOGIN_WINDOW_MS = 60_000;
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_LOGIN_SOURCES = 1024;

/** 原子保存会话并淘汰最早记录，使并发登录也遵守十个会话的上限。 */
const CREATE_SESSION_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)
for _, digest in ipairs(expired) do redis.call('DEL', ARGV[3] .. digest) end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local expires = now + tonumber(ARGV[1])
redis.call('SET', KEYS[2], cjson.encode({ownerId=ARGV[5], createdAt=now, expiresAt=expires}), 'PX', ARGV[1])
redis.call('ZADD', KEYS[1], expires, ARGV[2])
local excess = redis.call('ZCARD', KEYS[1]) - tonumber(ARGV[4])
if excess > 0 then
  local oldest = redis.call('ZPOPMIN', KEYS[1], excess)
  for i = 1, #oldest, 2 do redis.call('DEL', ARGV[3] .. oldest[i]) end
end
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return 1
`;

/** 同时撤销会话记录和数量索引，避免退出后的空项占用名额。 */
const REVOKE_SESSION_SCRIPT = `
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[1], ARGV[1])
return 1
`;

/** 原子记录来源次数，限制每分钟尝试数量及活跃来源总数。 */
const LOGIN_RATE_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local count = tonumber(redis.call('GET', KEYS[2]) or '0')
if count > 0 then
  if count >= tonumber(ARGV[2]) then return 0 end
  redis.call('INCR', KEYS[2])
  return 1
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('SET', KEYS[2], '1', 'PX', ARGV[1])
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[1]), ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return 1
`;

/** 在独立 Redis 命名空间中保存认证会话并管理连接。 */
export class RedisAuthStore {
  private readonly client;
  private readonly prefix: string;
  private readonly ratePrefix: string;
  private connecting: Promise<void> | null = null;
  private closed = false;

  /**
   * 初始化认证连接与凭据版本对应的会话范围。
   * @param url 仅服务端使用的 Redis 连接串。
   * @param namespace 同一部署所有后端共用的认证范围。
   * @param credentialVersion 由稳定密钥与部署密码派生的凭据版本。
   */
  constructor(url: string, namespace: string, credentialVersion: string) {
    this.prefix = `${namespace}:auth:${credentialVersion}`;
    this.ratePrefix = `${namespace}:auth:rate`;
    this.client = createClient({
      url,
      socket: { connectTimeout: COMMAND_TIMEOUT_MS, reconnectStrategy: false },
      disableOfflineQueue: true,
      commandsQueueMaxLength: 128,
    });
    // 客户端错误通过请求的受控 503 返回，避免底层日志带出连接凭据。
    this.client.on('error', () => undefined);
  }

  /**
   * 原子检查来源限流，多个后端共用同一个窗口和来源上限。
   * @param sourceDigest 可信连接来源的摘要。
   * @returns 当前来源是否仍允许尝试登录。
   */
  async allowLogin(sourceDigest: string): Promise<boolean> {
    return this.execute(
      async () =>
        (await this.client
          .withCommandOptions({ abortSignal: AbortSignal.timeout(COMMAND_TIMEOUT_MS) })
          .eval(LOGIN_RATE_SCRIPT, {
            keys: [`${this.ratePrefix}:sources`, `${this.ratePrefix}:source:${sourceDigest}`],
            arguments: [
              String(LOGIN_WINDOW_MS),
              String(MAX_LOGIN_ATTEMPTS),
              String(MAX_LOGIN_SOURCES),
              sourceDigest,
            ],
          })) === 1,
    );
  }

  /**
   * 保存会话摘要及到期时间，使用 Redis TTL 执行绝对过期。
   * @param digest 随机会话令牌的摘要。
   * @param lifetimeMs 会话自创建起的固定有效时长。
   * @param ownerId 已验证的持久用户标识。
   */
  async createSession(digest: string, lifetimeMs: number, ownerId: string): Promise<void> {
    await this.execute(async () => {
      await this.client
        .withCommandOptions({ abortSignal: AbortSignal.timeout(COMMAND_TIMEOUT_MS) })
        .eval(CREATE_SESSION_SCRIPT, {
          keys: [`${this.prefix}:sessions`, `${this.prefix}:session:${digest}`],
          arguments: [
            String(lifetimeMs),
            digest,
            `${this.prefix}:session:`,
            String(MAX_SESSIONS),
            ownerId,
          ],
        });
    });
  }

  /**
   * 查询尚未到期的会话，不延长其 Redis TTL。
   * @param digest 待验证会话令牌的摘要。
   * @returns 有效会话的数据归属；缺失或旧格式返回 null。
   */
  async sessionOwner(digest: string): Promise<string | null> {
    return this.execute(async () => {
      const value = await this.client
        .withCommandOptions({ abortSignal: AbortSignal.timeout(COMMAND_TIMEOUT_MS) })
        .get(`${this.prefix}:session:${digest}`);
      if (!value) return null;
      const session: unknown = JSON.parse(value);
      if (
        !session ||
        typeof session !== 'object' ||
        !('ownerId' in session) ||
        typeof session.ownerId !== 'string' ||
        !/^[a-f0-9-]{36}$/i.test(session.ownerId)
      )
        return null;
      return session.ownerId;
    });
  }

  /**
   * 撤销当前会话，其他终端的会话保持有效。
   * @param digest 要撤销的会话令牌摘要。
   */
  async revokeSession(digest: string): Promise<void> {
    await this.execute(async () => {
      await this.client
        .withCommandOptions({ abortSignal: AbortSignal.timeout(COMMAND_TIMEOUT_MS) })
        .eval(REVOKE_SESSION_SCRIPT, {
          keys: [`${this.prefix}:sessions`, `${this.prefix}:session:${digest}`],
          arguments: [digest],
        });
    });
  }

  /**
   * 检查认证存储当前是否可访问。
   * @returns Redis 是否能够完成经过认证的连接探测。
   */
  async isAvailable(): Promise<boolean> {
    try {
      return await this.execute(
        async () =>
          (await this.client
            .withCommandOptions({ abortSignal: AbortSignal.timeout(COMMAND_TIMEOUT_MS) })
            .ping()) === 'PONG',
      );
    } catch {
      return false;
    }
  }

  /** 关闭进程连接，保留已保存的会话及其剩余有效期。 */
  close(): void {
    this.closed = true;
    if (this.client.isOpen) this.client.destroy();
  }

  /**
   * 为一次 Redis 操作建立有界连接并转换受控故障响应。
   * @param operation 连接就绪后执行的单次操作，不自动重放。
   * @returns Redis 操作的结果。
   */
  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      if (this.closed) throw new Error();
      if (!this.client.isReady) {
        this.connecting ??= this.connect().finally(() => {
          this.connecting = null;
        });
        await this.connecting;
      }
      return await operation();
    } catch {
      throw new ApiException(API_CODES.AUTH_STORE_UNAVAILABLE);
    }
  }

  /** 限制连接和认证握手的总等待时间，避免无响应端点持续占用请求。 */
  private async connect(): Promise<void> {
    const timer = setTimeout(() => {
      if (this.client.isOpen) this.client.destroy();
    }, COMMAND_TIMEOUT_MS);
    timer.unref();
    try {
      await this.client.connect();
    } finally {
      clearTimeout(timer);
    }
  }
}
