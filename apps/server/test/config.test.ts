import { describe, expect, it } from 'vitest';
import { loadServerConfig } from '../src/config';

const BASE_ENV = {
  REDIS_URL: 'redis://localhost:6379',
  REDIS_NAMESPACE: 'configuration-test',
  AUTH_SESSION_SECRET: 'a'.repeat(64),
  ADMIN_PASSWORD: 'test-password-for-foundation',
  DATABASE_URL: 'mysql://test:test@localhost/memory_weave',
  QDRANT_URL: 'http://127.0.0.1:6333',
  QDRANT_API_KEY: 'test-vector-key',
};

describe('server bootstrap configuration', () => {
  it('拒绝缺失或不安全的 Redis 配置且不在错误中回显敏感值', () => {
    for (const [key, value] of [
      ['REDIS_URL', ''],
      ['REDIS_URL', 'https://private-user:private-password@redis.invalid'],
      ['REDIS_URL', 'redis://private-user:private-password@redis.invalid/?token=private'],
      ['REDIS_NAMESPACE', ''],
      ['REDIS_NAMESPACE', '*:unsafe'],
      ['AUTH_SESSION_SECRET', 'private-short-secret'],
    ]) {
      try {
        loadServerConfig({ ...BASE_ENV, [key!]: value });
        expect.fail('非法配置不应通过启动校验。');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(key);
        expect((error as Error).message).not.toContain('private');
      }
    }
    const config = loadServerConfig({
      ...BASE_ENV,
      REDIS_URL: 'rediss://user:encoded%40password@redis.invalid:6380/2',
    });
    expect(config.redisNamespace).toBe('configuration-test');
  });
  it('模型凭据只按部署环境引用读取，非法地址或直接内嵌密钥会被脱敏拒绝', () => {
    const definition = {
      id: 'local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKeyEnv: null,
      capabilities: ['text', 'embedding'],
    };
    const config = loadServerConfig({
      ...BASE_ENV,
      MODEL_PROVIDERS_JSON: JSON.stringify([definition]),
    });
    expect(config.modelDeployment?.providers[0]).toMatchObject({ id: 'local', apiKey: null });
    for (const invalid of [
      { ...definition, baseUrl: 'https://private-key@provider.invalid/v1' },
      { ...definition, apiKey: 'private-key' },
      { ...definition, apiKeyEnv: 'DATABASE_URL' },
    ]) {
      expect(() =>
        loadServerConfig({ ...BASE_ENV, MODEL_PROVIDERS_JSON: JSON.stringify([invalid]) }),
      ).toThrow('模型部署配置无效');
    }
  });
  it('accepts MySQL and rejects the old PostgreSQL URL without echoing credentials', () => {
    expect(loadServerConfig(BASE_ENV).databaseUrl).toBe(BASE_ENV.DATABASE_URL);
    expect(() =>
      loadServerConfig({
        ...BASE_ENV,
        DATABASE_URL: 'postgres://private:secret@localhost/memory_weave',
      }),
    ).toThrow(/MySQL/);
  });
  it('refuses a short owner password before opening a listener', () => {
    expect(() => loadServerConfig({ ...BASE_ENV, ADMIN_PASSWORD: 'short' })).toThrow(
      /ADMIN_PASSWORD/,
    );
  });

  it('refuses insecure cookies when the public origin is HTTPS', () => {
    expect(() =>
      loadServerConfig({
        ...BASE_ENV,
        APP_ORIGIN: 'https://companion.example',
        COOKIE_SECURE: 'false',
      }),
    ).toThrow(/COOKIE_SECURE/);
  });
});
