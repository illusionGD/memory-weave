import { describe, expect, it } from 'vitest';
import { loadServerConfig } from '../src/config';

const BASE_ENV = {
  ADMIN_PASSWORD: 'test-password-for-foundation',
  DATABASE_URL: 'mysql://test:test@localhost/memory_weave',
  QDRANT_URL: 'http://127.0.0.1:6333',
  QDRANT_API_KEY: 'test-vector-key',
};

describe('server bootstrap configuration', () => {
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
