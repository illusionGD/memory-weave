import { describe, expect, it } from 'vitest';
import { loadServerConfig } from '../src/config';

const BASE_ENV = {
  ADMIN_PASSWORD: 'test-password-for-foundation',
  DATABASE_URL: 'mysql://test:test@localhost/memory_weave',
  QDRANT_URL: 'http://127.0.0.1:6333',
  QDRANT_API_KEY: 'test-vector-key',
};

describe('server bootstrap configuration', () => {
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
