import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';

test('只发材料、查看片段及刷新后恢复全文总结', async ({ page }, testInfo) => {
  await page.goto('/');
  const created = await page.request.post('/api/companions', {
    data: {
      requestId: randomUUID(),
      name: `资料伴侣 ${testInfo.project.name}`,
      initialProfile: '保留原文依据。',
    },
  });
  expect(created.status()).toBe(201);
  const companion = (await created.json()).data;
  await page.goto(`/companions/${companion.id}`);
  await page.getByRole('button', { name: '开始聊天', exact: true }).click();
  await expect(page).toHaveURL(/\/chats\/[0-9a-f-]+$/);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '添加材料' }).click();
  await (
    await chooser
  ).setFiles({
    name: '星空札记.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 星空札记\n\n第一个地址是星河路八号。'),
  });
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const log = page.getByRole('log', { name: '聊天记录' });
  await expect(log.getByText('星空札记.md', { exact: true })).toBeVisible({ timeout: 20_000 });
  await log.getByRole('button', { name: '查看内容' }).click();
  await expect(log.getByText('第一个地址是星河路八号。')).toBeVisible();
  await log.getByRole('button', { name: '总结全文文字' }).click();
  await expect(log.getByText('全文文字总结完成', { exact: false })).toBeVisible({
    timeout: 20_000,
  });
  await page.reload();
  await expect(log.getByText('全文文字总结完成', { exact: false })).toBeVisible();
  await expect(log.getByText('星空札记.md', { exact: true })).toHaveCount(1);
});
