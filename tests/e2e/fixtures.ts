import { expect, test as base } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

type AuthenticatedState = Awaited<ReturnType<APIRequestContext['storageState']>>;

/** 功能测试复用当前 worker 的真实会话；登录、退出和重新登录仍单独通过界面验证。 */
export const test = base.extend<object, { authenticatedState: AuthenticatedState }>({
  authenticatedState: [
    async ({ playwright }, use, workerInfo) => {
      const client = await playwright.request.newContext({
        baseURL: workerInfo.project.use.baseURL,
      });
      try {
        const response = await client.post('/api/auth/login', {
          data: { password: 'Memory-Weave-E2E-Only-2026' },
        });
        expect(response.status()).toBe(200);
        await use(await client.storageState());
      } finally {
        await client.dispose();
      }
    },
    { scope: 'worker' },
  ],
  storageState: async ({ authenticatedState }, use) => {
    await use(authenticatedState);
  },
});

export { expect } from '@playwright/test';
