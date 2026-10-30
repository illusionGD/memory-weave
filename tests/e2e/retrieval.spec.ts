import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';

test('另一场私聊的新补充出现在本轮来源，刷新后仍能查看', async ({ page }, testInfo) => {
  const companion = (
    await (
      await page.request.post('/api/companions', {
        data: {
          requestId: randomUUID(),
          name: `回忆验收 ${testInfo.project.name}`,
          initialProfile: '保留自己的想法，喜欢日常交流。',
        },
      })
    ).json()
  ).data;
  const create = async (title: string) =>
    (
      await (
        await page.request.post('/api/chats', {
          data: { requestId: randomUUID(), companionId: companion.id, runtimeEpoch: 1, title },
        })
      ).json()
    ).data;
  const first = await create('地址补充');
  await page.goto(`/chats/${first.id}`);
  await page.getByLabel('消息', { exact: true }).fill('我已经搬到杭州文三路 18 号。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('回复已完成', { exact: true })).toBeVisible();
  const second = await create('延续回忆');
  await page.goto(`/chats/${second.id}`);
  await page.getByLabel('消息', { exact: true }).fill('给我寄东西用新地址就好。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('回复已完成', { exact: true })).toBeVisible();
  await page.getByText('本轮参考的记忆与新消息', { exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: '本轮回忆来源' })
      .getByText('我已经搬到杭州文三路 18 号。', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByText('本轮参考的记忆与新消息', { exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: '本轮回忆来源' })
      .getByText('我已经搬到杭州文三路 18 号。', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('retrieval.png'), fullPage: true });
});
