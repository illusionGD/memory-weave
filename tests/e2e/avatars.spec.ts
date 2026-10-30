import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4XkAAAAASUVORK5CYII=',
  'base64',
);
test('头像预览、保存与跨端修改同步，不清空正在编辑的聊天草稿', async ({
  page,
  context,
}, testInfo) => {
  const created = await page.request.post('/api/companions', {
    data: {
      requestId: randomUUID(),
      name: `星晚 ${testInfo.project.name}`,
      initialProfile: '喜欢宁静的夜空，记得一起走过的路。',
    },
  });
  expect(created.status()).toBe(201);
  const companion = (await created.json()).data;
  await page.goto(`/companions/${companion.id}`);
  const editor = page.getByRole('region', { name: '自定义头像' });
  await editor
    .getByLabel('选择头像图片')
    .setInputFiles({ name: 'moon.png', mimeType: 'image/png', buffer: png });
  await expect(editor.locator('img')).toHaveAttribute('src', /^blob:/);
  const before = await page.request.get(`/api/companions/${companion.id}`);
  expect((await before.json()).data.avatar).toBeNull();
  await editor.getByRole('button', { name: '保存头像', exact: true }).click();
  await expect(editor.getByRole('status')).toHaveText('头像已保存。');
  await expect(editor.locator('img')).toHaveAttribute('src', /^\/api\/companions\//);
  await page.reload();
  await expect(editor.locator('img')).toHaveJSProperty('naturalWidth', 512);
  await page.screenshot({ path: testInfo.outputPath('avatar-profile.png'), fullPage: true });
  await page.getByRole('button', { name: '开始聊天', exact: true }).click();
  await expect(page.getByLabel('查看伴侣资料').locator('img')).toHaveJSProperty(
    'naturalWidth',
    512,
  );
  const draft = page.getByLabel('消息', { exact: true });
  await draft.fill('今晚想和你聊聊星星。');
  const admin = await context.newPage();
  await admin.goto(`/admin/companions/${companion.id}`);
  await admin.getByRole('button', { name: '恢复默认头像' }).click();
  await expect(admin.getByRole('region', { name: '自定义头像' }).getByRole('status')).toHaveText(
    '头像已保存。',
  );
  await expect(page.getByLabel('查看伴侣资料').locator('img')).toHaveCount(0);
  await expect(draft).toHaveValue('今晚想和你聊聊星星。');
  await admin.close();
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(
    page.getByText('测试模型已收到：今晚想和你聊聊星星。', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const composer = await draft.boundingBox();
  expect(composer!.y + composer!.height).toBeLessThan(page.viewportSize()!.height);
  await page.screenshot({ path: testInfo.outputPath('starry-chat.png'), fullPage: true });
});
