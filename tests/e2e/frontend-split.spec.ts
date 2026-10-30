import { expect, test } from './fixtures';

test('聊天与后台拥有独立入口、导航和刷新路径', async ({ page }, testInfo) => {
  await page.goto('/chats');
  await expect(page).toHaveTitle('Memory Weave');
  await expect(page.getByRole('navigation', { name: '个人空间' })).toBeVisible();
  await expect(page.getByRole('link', { name: '人设模板', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '清理记录', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '伴侣', exact: true }).click();
  await page.getByRole('link', { name: '创建伴侣', exact: true }).click();
  await expect(page.getByLabel('一段人设')).toBeVisible();
  await page.getByRole('link', { name: '私聊', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('chat-home.png'), fullPage: true });

  await page.goto('/admin/companions');
  await expect(page).toHaveTitle('Memory Weave · 管理后台');
  await expect(page.getByRole('navigation', { name: '后台管理' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '伴侣管理', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '伴侣管理', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '记忆记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '记忆记录', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '运行概览', exact: true }).click();
  await expect(page.getByRole('heading', { name: '服务已就绪', exact: true })).toBeVisible();
  await expect(page.getByLabel('消息', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('admin-overview.png'), fullPage: true });
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('link', { name: '打开聊天端 ↗' }).click();
  const chatPage = await popupPromise;
  await expect(chatPage.getByRole('heading', { name: '私聊', exact: true })).toBeVisible();
  await chatPage.close();
});
