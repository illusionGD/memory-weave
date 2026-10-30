import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';

test('删除原文同步清除另一窗口缓存，重置和删除实例均可查看完成进度', async ({
  page,
  context,
}, testInfo) => {
  const created = await page.request.post('/api/companions', {
    data: {
      requestId: randomUUID(),
      name: `生命周期 ${testInfo.project.name}`,
      initialProfile: '出生在海边，保留独立思考。',
    },
  });
  expect(created.status()).toBe(201);
  const companion = (await created.json()).data;
  await page.goto(`/companions/${companion.id}`);
  await page.getByRole('button', { name: '开始聊天', exact: true }).click();
  await expect(page).toHaveURL(/\/chats\/[0-9a-f-]+$/);
  const chatUrl = page.url();
  await page.getByLabel('消息', { exact: true }).fill('需要删除的私人暗号。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('回复已完成', { exact: true })).toBeVisible();
  const other = await context.newPage();
  await other.goto(chatUrl);
  await expect(
    other.getByRole('log', { name: '聊天记录' }).getByText('需要删除的私人暗号。', { exact: true }),
  ).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '删除这条消息', exact: true }).first().click();
  await expect(page).toHaveURL(chatUrl);
  await expect(page.getByText('需要删除的私人暗号。', { exact: true })).toHaveCount(0);
  await expect(other.getByText('需要删除的私人暗号。', { exact: true })).toHaveCount(0);
  await expect(
    other.getByText('测试模型已收到：需要删除的私人暗号。', { exact: true }),
  ).toHaveCount(0);
  await expect(other.getByText('内容已删除', { exact: true }).first()).toBeVisible();
  await page.goto(`/admin/companions/${companion.id}`);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '重置伴侣', exact: true }).click();
  await expect(page.getByRole('heading', { name: '清理已完成', exact: true })).toBeVisible();
  await expect(other.getByText('历史会话 · 只读', { exact: true })).toBeVisible();
  await expect(other.getByLabel('消息', { exact: true })).toBeDisabled();
  await page.getByRole('link', { name: '查看伴侣', exact: true }).click();
  await expect(page.getByText('出生在海边，保留独立思考。', { exact: true })).toBeVisible();
  await page.goto(`/companions/${companion.id}`);
  await page.getByRole('button', { name: '开始聊天', exact: true }).click();
  await expect(page.getByText('从今天想聊的开始', { exact: true })).toBeVisible();
  expect(page.url()).not.toBe(chatUrl);
  await page.goto(`/admin/companions/${companion.id}`);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '删除伴侣', exact: true }).click();
  await expect(page.getByRole('heading', { name: '清理已完成', exact: true })).toBeVisible();
  expect((await page.request.get(`/api/companions/${companion.id}`)).status()).toBe(404);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('lifecycle-completed.png'), fullPage: true });
  await other.close();
});
