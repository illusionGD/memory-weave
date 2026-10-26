import { describe, expect, it } from 'vitest';
import { loadServerConfig } from '../src/config';

const BASE_ENV = {
  ADMIN_PASSWORD: 'test-password-for-foundation',
  DATABASE_URL: 'postgres://test:test@localhost/memory_weave',
};

describe('server bootstrap configuration', () => {
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
