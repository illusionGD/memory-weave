import { expect, test } from '@playwright/test';

test('显示名称可修改并在刷新和重新登录后保留', async ({ page }, testInfo) => {
  await page.goto('/settings');
  await expect(page.getByLabel('部署密码')).toBeVisible();
  await page.getByLabel('部署密码').fill('Memory-Weave-E2E-Only-2026');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('link', { name: '个人设置', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '个人设置', exact: true }).click();
  const name = page.getByLabel('显示名称', { exact: true });
  await expect(name).toHaveValue(/\S/);
  const originalName = await name.inputValue();
  const changedName = `林间访客 · ${testInfo.project.name === 'desktop' ? '桌面' : '移动'}`;
  let flowCompleted = false;

  try {
    await name.fill('   ');
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('请输入 1～80 个字符的显示名称。');
    // 在 HTTP 边界模拟各版本终端可能遇到的响应，不替换页面、store 或请求层。
    const traceId = 'e4f34b29-3f5d-4f37-9266-4764bbd61cee';
    for (const failure of [
      {
        status: 409,
        code: 'VERSION_CONFLICT',
        statusCode: 409,
        expected: '数据版本已变化，请刷新后核对。',
      },
      {
        status: 409,
        code: 'FUTURE_CONFLICT',
        statusCode: 409,
        expected: '操作与当前状态冲突，请刷新后核对。',
      },
      {
        status: 400,
        code: 'VERSION_CONFLICT',
        statusCode: 409,
        expected: '请求参数不符合接口约定。',
      },
      { status: 503, code: null, statusCode: 503, expected: '服务暂时不可用，请稍后重试。' },
    ]) {
      await page.route('**/api/workspace', async (route) => {
        if (route.request().method() !== 'PATCH') return route.continue();
        await route.fulfill({
          status: failure.status,
          headers: { 'X-Request-Id': traceId },
          contentType: failure.code ? 'application/json' : 'text/html',
          body: failure.code
            ? JSON.stringify({
                statusCode: failure.statusCode,
                code: failure.code,
                message: '不应展示的远端原始诊断信息',
                requestId: traceId,
              })
            : '<html>不应展示的代理错误页面</html>',
        });
      });
      await name.fill(changedName);
      await page.getByRole('button', { name: '保存名称', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveText(failure.expected);
      await expect(name).toHaveValue(changedName);
      await page.unroute('**/api/workspace');
    }
    await name.fill(`  ${changedName}  `);
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('显示名称已保存。');
    await page.reload();
    await expect(name).toHaveValue(changedName);

    // 桌面覆盖跨登录持久化；移动端重复验证编辑和刷新，避免重复登录占用基础限流额度。
    if (testInfo.project.name === 'desktop') {
      await page.getByRole('button', { name: '退出登录', exact: true }).click();
      await expect(page.getByLabel('部署密码')).toBeVisible();
      await page.getByLabel('部署密码').fill('Memory-Weave-E2E-Only-2026');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.getByRole('link', { name: '个人设置', exact: true }).click();
      await expect(name).toHaveValue(changedName);
    }
    flowCompleted = true;
  } finally {
    await page.unroute('**/api/workspace');
    const restored = await page.request.patch('/api/workspace', {
      data: { displayName: originalName },
    });
    if (flowCompleted) {
      expect(restored.status()).toBe(200);
    } else if (!restored.ok()) {
      await testInfo.attach('cleanup-note', {
        body: `恢复测试前名称未成功，HTTP ${restored.status()}。保留主流程的原始失败。`,
        contentType: 'text/plain',
      });
    }
  }

  if (testInfo.project.name === 'desktop') {
    await page.context().clearCookies();
    await name.fill('会话已失效的编辑');
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(page.getByLabel('部署密码')).toBeVisible();
  } else {
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
  }
  await page.goto('/settings');
  await expect(page.getByLabel('部署密码')).toBeVisible();
  await expect(page.getByLabel('显示名称', { exact: true })).toHaveCount(0);
  const denied = await page.request.patch('/api/workspace', { data: { displayName: '未登录' } });
  expect(denied.status()).toBe(401);
});
