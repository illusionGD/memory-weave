import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';

test('后台按伴侣进入记忆浏览，空状态、筛选和刷新可用', async ({ page }, testInfo) => {
  const companion = (
    await (
      await page.request.post('/api/companions', {
        data: {
          requestId: randomUUID(),
          name: `浏览验收 ${testInfo.project.name}`,
          initialProfile: '喜欢安静地交流。',
        },
      })
    ).json()
  ).data;
  await page.goto(`/admin/companions/${companion.id}/memories?runtimeEpoch=1`);
  await expect(page.getByRole('heading', { name: '记忆浏览', exact: true })).toBeVisible();
  await expect(page.getByText('当前范围还没有符合条件的记忆。')).toBeVisible();
  await page.getByLabel('关键词', { exact: true }).fill('杭州');
  await page.getByRole('button', { name: '应用筛选', exact: true }).click();
  await expect(page.getByText('当前范围还没有符合条件的记忆。')).toBeVisible();
  await page.getByRole('button', { name: '时间线', exact: true }).click();
  await expect(page.getByText('按记下时间排序；经历时间保留原有描述。')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '记忆浏览', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('查看跨私聊记忆、时间线和图谱，删除来源后拒绝迟到正文', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const api = page.request;
  const current = (await (await api.get('/api/models/config')).json()).data;
  const configured = structuredClone(current.config);
  Object.assign(configured.tasks.memory, {
    providerId: 'memory-explorer-fixture',
    model: 'memory-explorer-fixture',
    inputMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
  });
  expect(
    (
      await api.put('/api/models/config', {
        data: {
          requestId: randomUUID(),
          expectedVersion: current.version,
          config: configured,
          evaluationNote: '隔离浏览器协议验收，不评价真实模型。',
        },
      })
    ).status(),
  ).toBe(200);
  let release: (() => void) | undefined;
  try {
    const companion = (
      await (
        await api.post('/api/companions', {
          data: {
            requestId: randomUUID(),
            name: '知夏',
            initialProfile: '记得共同经历，也会保留不确定的判断。',
          },
        })
      ).json()
    ).data;
    async function conversation(title: string) {
      const response = await api.post('/api/conversations', {
        data: {
          requestId: randomUUID(),
          title,
          kind: 'private',
          includeUser: true,
          companions: [{ companionId: companion.id, runtimeEpoch: 1 }],
        },
      });
      expect(response.status()).toBe(201);
      return (await response.json()).data.conversation;
    }
    async function remember(conversationId: string, text: string) {
      const state = (await (await api.get(`/api/conversations/${conversationId}`)).json()).data
        .conversation;
      const saved = (
        await (
          await api.post(`/api/conversations/${conversationId}/messages`, {
            data: {
              requestId: randomUUID(),
              speaker: { kind: 'user' },
              expectedConversationVersion: state.version,
              text,
            },
          })
        ).json()
      ).data;
      const next = (await (await api.get(`/api/conversations/${conversationId}`)).json()).data
        .conversation;
      const published = await api.post(
        `/api/conversations/${conversationId}/messages/${saved.id}/publish`,
        {
          data: {
            requestId: randomUUID(),
            expectedRevision: saved.revision,
            expectedConversationVersion: next.version,
          },
        },
      );
      expect(published.status()).toBe(201);
      const organized = await api.post(`/api/companions/${companion.id}/memories/organize`, {
        data: { requestId: randomUUID(), runtimeEpoch: 1, conversationId },
      });
      expect(organized.status()).toBe(201);
      const task = (await organized.json()).data.taskId;
      await expect
        .poll(async () => (await (await api.get(`/api/tasks/${task}`)).json()).data.status, {
          timeout: 15000,
        })
        .toBe('succeeded');
      return (await published.json()).data;
    }
    const first = await conversation('搬家与生活');
    const second = await conversation('雨天与故事');
    const oldSource = await remember(first.id, '我住杭州。');
    await remember(first.id, '昨天搬到苏州了。');
    const currentSource = await remember(first.id, '刚才说错了，其实住南京。');
    await remember(second.id, '也许我更喜欢雨天。');
    await remember(second.id, '故事《月之旅》的主角住在月亮。');
    // 浏览器在后台打开页面时不采用正文，重新可见后应完成初始化。
    await page.addInitScript(() =>
      Object.defineProperty(document, 'hidden', { configurable: true, value: true }),
    );
    const initialIdentity = page.waitForResponse((response) =>
      response.url().endsWith(`/api/companions/${companion.id}`),
    );
    await page.goto(`/admin/companions/${companion.id}/memories?runtimeEpoch=1`);
    await initialIdentity;
    await expect(page.getByRole('button', { name: '刷新记忆', exact: true })).toBeEnabled();
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const results = page.getByRole('region', { name: '记忆浏览结果' });
    await expect(results.getByText('用户住南京。', { exact: true })).toBeVisible();
    await expect(results.getByText('用户可能更喜欢雨天。', { exact: true })).toBeVisible();
    await expect(results.getByText('创作 · 月之旅', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '时间线', exact: true }).click();
    await expect(results.getByRole('heading', { name: '情况变化', exact: true })).toBeVisible();
    await expect(results.getByRole('heading', { name: '纠正旧记录', exact: true })).toBeVisible();
    await expect(results.getByText('经历时间：昨天', { exact: false })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath('memory-timeline.png'), fullPage: true });
    const oldVersion = results.locator('article').filter({ hasText: '用户住苏州。' });
    await oldVersion.getByRole('button', { name: '查看关系图谱' }).click();
    await expect(
      page.getByRole('img', { name: '记忆、版本和原文的关系图' }).locator('canvas').first(),
    ).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: '局部记忆关系图' })
        .getByText('昨天搬到苏州了。', { exact: true }),
    ).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath('memory-graph.png'), fullPage: true });
    await page.getByRole('button', { name: '记忆列表', exact: true }).click();
    await results
      .locator('article')
      .filter({ hasText: '用户住南京。' })
      .getByRole('button', { name: '查看来源与历史' })
      .click();
    await expect(
      page
        .getByRole('region', { name: '记忆来源与历史' })
        .getByText('刚才说错了，其实住南京。', { exact: true }),
    ).toBeVisible();
    let captured!: () => void;
    const fetched = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      `**/api/companions/${companion.id}/sources/${currentSource.id}?*`,
      async (route) => {
        const response = await route.fetch();
        captured();
        await held;
        await route.fulfill({ response });
      },
    );
    await page.getByRole('button', { name: '查看完整原文', exact: true }).click();
    await fetched;
    const conversationVersion = (await (await api.get(`/api/conversations/${first.id}`)).json())
      .data.conversation.version;
    const deleted = await api.post('/api/lifecycle', {
      data: {
        requestId: randomUUID(),
        kind: 'delete_messages',
        conversationId: first.id,
        expectedVersion: conversationVersion,
        messages: [{ messageId: oldSource.id, contentVersion: 1 }],
      },
    });
    expect(deleted.status()).toBe(201);
    await expect(page.getByText('记忆或来源已变化，已清除旧画面，请刷新后继续。')).toBeVisible({
      timeout: 10000,
    });
    release();
    await expect(page.getByRole('region', { name: '完整原文' })).toHaveCount(0);
    await expect(page.getByText('用户住南京。', { exact: true })).toHaveCount(0);
    await expect(page.getByText('刚才说错了，其实住南京。', { exact: true })).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  } finally {
    release?.();
    await page.unrouteAll({ behavior: 'wait' });
    const latest = (await (await api.get('/api/models/config')).json()).data;
    expect(
      (
        await api.put('/api/models/config', {
          data: {
            requestId: randomUUID(),
            expectedVersion: latest.version,
            config: current.config,
            evaluationNote: '恢复浏览器验收前的模型配置。',
          },
        })
      ).status(),
    ).toBe(200);
  }
});
