import { expect, test } from '@playwright/test';

test('部署者登录后能查看运行状态，退出后需要重新登录', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('部署密码')).toBeVisible();
  await page.getByLabel('部署密码').fill('Memory-Weave-E2E-Only-2026');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运行状态', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '运行状态', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByLabel('部署密码')).toBeVisible();
  const privateResponse = await page.request.get('/api/system/status');
  expect(privateResponse.status()).toBe(401);
});
