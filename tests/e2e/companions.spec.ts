import { expect, test } from './fixtures';

test('一段人设自动创建，刷新后可查初始人格并保留约束修订历史', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('link', { name: '伴侣', exact: true }).click();
  await page.getByRole('link', { name: '创建伴侣', exact: true }).click();
  const name = `小夜 ${testInfo.project.name} ${Date.now()}`;
  await page.getByLabel('名字（可选）').fill(name);
  await page.getByLabel('一段人设').fill('小夜喜欢文学，起初慢热，希望她始终保留独立思考。');
  await page.getByRole('button', { name: '创建伴侣', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByText('初始人格已整理')).toBeVisible();
  await page.reload();
  await expect(page.getByText('测试模式', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '管理长期约束', exact: true }).click();
  await page.getByLabel('长期保留的约束').fill('保持独立思考\n始终真诚');
  await page.getByRole('button', { name: '保存约束', exact: true }).click();
  await expect(page.getByText('当前人格 · 第 3 版')).toBeVisible();
  await expect(page.getByText('始终真诚', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '初始人格', exact: true }).click();
  await expect(page.getByText('初始人格 · 第 2 版')).toBeVisible();
  await expect(page.getByText('始终真诚', { exact: true })).toHaveCount(0);
  await expect(
    page.getByText('小夜喜欢文学，起初慢热，希望她始终保留独立思考。', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('模板保留版本，编辑后仍可从旧版本创建独立伴侣', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('link', { name: '伴侣', exact: true }).click();
  await page.getByRole('link', { name: '人设模板', exact: true }).click();
  await page.getByRole('button', { name: '新建模板', exact: true }).click();
  const name = `文学模板 ${testInfo.project.name} ${Date.now()}`;
  await page.getByLabel('模板名称').fill(name);
  await page.getByLabel('一段人设').fill('小夜喜欢文学。');
  await page.getByRole('button', { name: '保存模板', exact: true }).click();
  await expect(page.getByRole('heading', { name: `${name} · 第 1 版`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '编辑模板', exact: true }).click();
  await page.getByLabel('一段人设').fill('小夜喜欢旅行。');
  await page.getByRole('button', { name: '保存新版本', exact: true }).click();
  await page.getByLabel('模板历史版本').fill('1');
  await page.getByRole('button', { name: '读取模板版本', exact: true }).click();
  await expect(page.getByText('小夜喜欢文学。', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '用此版本创建伴侣', exact: true }).click();
  await page.getByRole('button', { name: '创建伴侣', exact: true }).click();
  await expect(page.getByText('初始人格已整理')).toBeVisible();
  await expect(page.getByText('小夜喜欢文学。', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('来自人设模板的第 1 版', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
