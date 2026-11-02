import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import type { ServerConfig } from '../../src/config';

type TestAuthConfig = Pick<ServerConfig, 'redisUrl' | 'redisNamespace' | 'authSessionSecret'>;
const scopes = new Map<string, string>();

/**
 * 为测试创建独立认证命名空间，禁止隐式使用部署 Redis。
 * @returns 使用显式测试连接、随机前缀和独立密钥的认证配置。
 */
export function createTestAuthConfig(): TestAuthConfig {
  const redisUrl = process.env.TEST_REDIS_URL;
  if (!redisUrl) throw new Error('真实认证测试必须显式设置 TEST_REDIS_URL。');
  const redisNamespace = `mw-test-${randomUUID()}`;
  scopes.set(redisNamespace, redisUrl);
  return { redisUrl, redisNamespace, authSessionSecret: randomBytes(32).toString('hex') };
}

/**
 * 将测试应用的认证范围传给配置加载器或测试子进程。
 * @param config 当前测试需要共享的认证配置。
 * @returns 可与其他测试环境变量合并的认证字段。
 */
export function testAuthEnvironment(config: TestAuthConfig): NodeJS.ProcessEnv {
  return {
    REDIS_URL: config.redisUrl,
    REDIS_NAMESPACE: config.redisNamespace,
    AUTH_SESSION_SECRET: config.authSessionSecret,
  };
}

/** 清理本轮生成的独立认证前缀，不触碰其他测试或部署数据。 */
export async function disposeTestAuth(): Promise<void> {
  for (const [namespace, url] of scopes) {
    const client = createClient({
      url,
      socket: { connectTimeout: 1000, reconnectStrategy: false },
    });
    client.on('error', () => undefined);
    try {
      await client.connect();
      for await (const keys of client.scanIterator({ MATCH: `${namespace}:*`, COUNT: 100 })) {
        if (keys.length) await client.unlink(keys);
      }
    } finally {
      if (client.isOpen) client.destroy();
    }
  }
  scopes.clear();
}
