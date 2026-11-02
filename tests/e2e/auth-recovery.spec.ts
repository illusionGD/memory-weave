import { expect, test } from './fixtures';

for (const entry of [
  { path: '/chats', heading: '私聊', label: '聊天端' },
  { path: '/admin/', heading: '运行状态', label: '后台' },
]) {
  test(`${entry.label}鉴权暂时不可用时保留 Cookie，恢复后可重试进入`, async ({ page, context }) => {
    await page.goto(entry.path);
    await expect(page.getByRole('heading', { name: entry.heading, exact: true })).toBeVisible();
    const before = (await context.cookies()).find(
      (cookie) => cookie.name === 'memory_weave_session',
    );
    expect(before).toBeDefined();
    await page.route('**/api/auth/session', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 50303,
          data: null,
          message: '鉴权服务暂时不可用，请稍后重试。',
        }),
      }),
    );
    await page.reload();
    await expect(page.getByRole('button', { name: '重新检查登录状态', exact: true })).toBeVisible();
    await expect(page.getByLabel('部署密码')).toHaveCount(0);
    const during = (await context.cookies()).find(
      (cookie) => cookie.name === 'memory_weave_session',
    );
    expect(during?.value).toBe(before!.value);
    await page.unroute('**/api/auth/session');
    await page.getByRole('button', { name: '重新检查登录状态', exact: true }).click();
    await expect(page.getByRole('heading', { name: entry.heading, exact: true })).toBeVisible();
    const after = (await context.cookies()).find(
      (cookie) => cookie.name === 'memory_weave_session',
    );
    expect(after?.value).toBe(before!.value);
  });
}
