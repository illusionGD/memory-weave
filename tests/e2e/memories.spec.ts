import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';

test('从私聊查看记忆，测试批次零条目也完成，刷新保留整理结果', async ({ page }, testInfo) => {
  const companion = (
    await (
      await page.request.post('/api/companions', {
        data: {
          requestId: randomUUID(),
          name: `记忆验收 ${testInfo.project.name}`,
          initialProfile: '喜欢日常聊天。',
        },
      })
    ).json()
  ).data;
  const chat = (
    await (
      await page.request.post('/api/chats', {
        data: {
          requestId: randomUUID(),
          companionId: companion.id,
          runtimeEpoch: 1,
          title: '记忆整理验收',
        },
      })
    ).json()
  ).data;
  await page.goto(`/chats/${chat.id}`);
  await page.getByLabel('消息', { exact: true }).fill('今天天气不错。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('回复已完成', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '这段对话的记忆' }).click();
  await expect(page.getByRole('heading', { name: '这段对话留下的记忆' })).toBeVisible();
  await expect(page.getByRole('button', { name: '现在整理', exact: true })).toHaveCount(0);
  await page.goto(`/admin/companions/${companion.id}/memories/${chat.id}?runtimeEpoch=1`);
  await page.getByRole('button', { name: '现在整理', exact: true }).click();
  await expect(page.getByRole('heading', { name: '2 条原文 · 整理完成' })).toBeVisible({
    timeout: 15000,
  });
  await expect(
    page.getByText('测试模式：验证保存与进度，返回空候选，不代表真实提取效果。'),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '2 条原文 · 整理完成' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('memories.png'), fullPage: true });
});
