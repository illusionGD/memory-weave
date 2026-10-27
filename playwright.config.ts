import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEST_PASSWORD = 'Memory-Weave-E2E-Only-2026';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'pnpm --filter @memory-weave/server start',
    url: `${BASE_URL}/api/health/live`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      NODE_ENV: 'test',
      QDRANT_URL: process.env.TEST_QDRANT_URL ?? process.env.QDRANT_URL ?? 'http://127.0.0.1:6333',
      QDRANT_API_KEY: process.env.TEST_QDRANT_API_KEY ?? process.env.QDRANT_API_KEY ?? '',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      ADMIN_PASSWORD: TEST_PASSWORD,
      APP_ORIGIN: BASE_URL,
      COOKIE_SECURE: 'false',
      DATA_DIR: resolve(tmpdir(), 'memory-weave-e2e', String(process.pid)),
      WEB_DIST_DIR: resolve('apps/web/dist'),
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        process.env.DATABASE_URL ??
        'mysql://memory_weave:memory_weave_test@127.0.0.1:3306/memory_weave_test',
    },
  },
});
