import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const TEST_PASSWORD = 'Memory-Weave-E2E-Only-2026';
if (!process.env.TEST_REDIS_URL) {
  throw new Error('浏览器测试需要显式配置独立的 TEST_REDIS_URL，不使用部署 Redis。');
}
// 当前运行的各项目独立限流；HTTP 测试另外覆盖同配置多进程共享会话。
const redisNamespace = `memory-weave:e2e:${randomBytes(12).toString('hex')}`;
process.env.MEMORY_WEAVE_E2E_REDIS_NAMESPACE = redisNamespace;
const sessionSecret = randomBytes(32).toString('hex');

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalTeardown: './scripts/cleanup-e2e-redis.mjs',
  use: {
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4173' } },
    { name: 'mobile', use: { ...devices['Pixel 7'], baseURL: 'http://127.0.0.1:4174' } },
  ],
  // 各终端有独立测试前缀和登录限流窗口，仍使用真实认证和同一持久数据库。
  webServer: [
    {
      command: 'node tests/fixtures/memory-explorer-provider.mjs',
      url: 'http://127.0.0.1:4185/health',
      reuseExistingServer: false,
      timeout: 10000,
    },
    ...[4173, 4174].map((port) => ({
      command: 'pnpm --filter @memory-weave/server start',
      url: `http://127.0.0.1:${port}/api/health/live`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        NODE_ENV: 'test',
        // 非空记忆经真实 HTTP 模型边界生成；测试数据不依赖外部供应商或费用。
        MODEL_PROVIDERS_JSON: JSON.stringify([
          {
            id: 'memory-explorer-fixture',
            baseUrl: 'http://127.0.0.1:4185/v1',
            apiKeyEnv: null,
            capabilities: ['structured'],
          },
        ]),
        MEMORY_CONFIG_JSON: JSON.stringify({ enabled: false, contextMessages: 0 }),
        QDRANT_URL:
          process.env.TEST_QDRANT_URL ?? process.env.QDRANT_URL ?? 'http://127.0.0.1:6333',
        QDRANT_API_KEY: process.env.TEST_QDRANT_API_KEY ?? process.env.QDRANT_API_KEY ?? '',
        HOST: '127.0.0.1',
        PORT: String(port),
        ADMIN_PASSWORD: TEST_PASSWORD,
        REDIS_URL: process.env.TEST_REDIS_URL,
        REDIS_NAMESPACE: `${redisNamespace}:${port}`,
        AUTH_SESSION_SECRET: sessionSecret,
        APP_ORIGIN: `http://127.0.0.1:${port}`,
        COOKIE_SECURE: 'false',
        DATA_DIR: resolve(tmpdir(), 'memory-weave-e2e', String(process.pid), String(port)),
        WEB_DIST_DIR: resolve('apps/web/dist'),
        ADMIN_DIST_DIR: resolve('apps/admin/dist'),
        ADMIN_APP_ORIGIN: `http://127.0.0.1:${port}`,
        DATABASE_URL:
          process.env.TEST_DATABASE_URL ??
          process.env.DATABASE_URL ??
          'mysql://memory_weave:memory_weave_test@127.0.0.1:3306/memory_weave_test',
      },
    })),
  ],
});
