import { expect, test as base } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

type AuthenticatedState = Awaited<ReturnType<APIRequestContext['storageState']>>;

/** 在真实浏览器边界收集运行时异常和内容安全策略违规。 */
export const browserTest = base.extend<{ browserDiagnostics: void }>({
  browserDiagnostics: [
    async ({ context }, use, testInfo) => {
      const errors: string[] = [];
      /** 记录当前窗口的脚本异常和 CSP 违规。 */
      function observe(page: Page): void {
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error' && message.text().startsWith('[CSP] ')) {
            errors.push(message.text());
          }
        });
      }
      context.on('page', observe);
      await context.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) => {
          console.error(
            `[CSP] ${event.violatedDirective}: ${event.blockedURI} (${event.sourceFile}:${event.lineNumber}:${event.columnNumber})`,
          );
        });
      });
      await use();
      context.off('page', observe);
      if (errors.length) {
        await testInfo.attach('browser-errors', {
          body: JSON.stringify(errors, null, 2),
          contentType: 'application/json',
        });
      }
      expect(errors, '页面不应产生未处理异常或 CSP 违规').toEqual([]);
    },
    { auto: true },
  ],
});

/** 功能测试复用当前 worker 的真实会话；登录、退出和重新登录仍单独通过界面验证。 */
export const test = browserTest.extend<object, { authenticatedState: AuthenticatedState }>({
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
  /** 为浏览器验收建立登录状态。 */
  storageState: async ({ authenticatedState }, use) => {
    await use(authenticatedState);
  },
});

export { expect } from '@playwright/test';
