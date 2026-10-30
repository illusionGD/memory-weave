import { expect, test } from './fixtures';
import { randomUUID } from 'node:crypto';

test('从伴侣开始私聊，原文与回复刷新后保留，断网重试不重复发送', async ({
  page,
  context,
}, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '运行状态', exact: true })).toBeVisible();
  const created = await page.request.post('/api/companions', {
    data: {
      requestId: randomUUID(),
      name: `阿澜 ${testInfo.project.name}`,
      initialProfile: '出生在海边，喜欢散步。',
    },
  });
  expect(created.status()).toBe(201);
  const companion = (await created.json()).data;
  await page.goto(`/companions/${companion.id}`);
  await page.getByRole('button', { name: '开始聊天', exact: true }).click();
  await expect(page).toHaveURL(/\/chats\/[0-9a-f-]+$/);
  await page.getByLabel('消息', { exact: true }).fill('我刚搬到杭州。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('测试模型已收到：我刚搬到杭州。', { exact: true })).toBeVisible();
  await expect(page.getByText('回复已完成', { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('log', { name: '聊天记录' }).getByText('我刚搬到杭州。', { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByText('测试模型已收到：我刚搬到杭州。', { exact: true })).toHaveCount(1);
  await context.setOffline(true);
  await page.getByLabel('消息', { exact: true }).fill('周末想去散步。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await context.setOffline(false);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('测试模型已收到：周末想去散步。', { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('log', { name: '聊天记录' }).getByText('周末想去散步。', { exact: true }),
  ).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('private-chat.png'), fullPage: true });
});
