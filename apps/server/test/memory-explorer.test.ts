import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  companionDetailSchema,
  conversationDetailSchema,
  draftMessageSchema,
  publishedMessageSchema,
  memoryListSchema,
} from '@memory-weave/contracts';
import type { MemoryDocument } from '@memory-weave/contracts';
import { loadServerConfig } from '../src/config';
import { createApplication } from '../src/app';
import { TaskWorkerService } from '../src/modules/tasks/task-worker.service';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';

describe('记忆浏览的公开查询协议', () => {
  let app: INestApplication;
  let database: TestDatabase;
  let dataDir: string;
  let provider: Server;
  let responseValue: unknown;
  let agent: ReturnType<typeof request.agent>;
  beforeEach(async () => {
    database = await createTestDatabase();
    dataDir = await mkdtemp(join(tmpdir(), 'memory-weave-explorer-'));
    provider = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(responseValue) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 30, completion_tokens: 70 },
        }),
      );
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('测试供应商未启动');
    app = await createApplication(
      loadServerConfig({
        DATABASE_URL: database.databaseUrl,
        ADMIN_PASSWORD: 'explorer-test-password',
        QDRANT_API_KEY: 'test-vector-key',
        DATA_DIR: dataDir,
        MEMORY_CONFIG_JSON: JSON.stringify({ enabled: false, contextMessages: 0 }),
        MODEL_PROVIDERS_JSON: JSON.stringify([
          {
            id: 'fixture',
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKeyEnv: null,
            capabilities: ['structured'],
          },
        ]),
      }),
    );
    agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: 'explorer-test-password' }).expect(200);
    const current = (await agent.get('/api/models/config').expect(200)).body.data;
    Object.assign(current.config.tasks.memory, {
      providerId: 'fixture',
      model: 'memory-fixture',
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
    });
    await agent
      .put('/api/models/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: current.version,
        config: current.config,
        evaluationNote: '隔离的查询协议验收。',
      })
      .expect(200);
  });
  afterEach(async () => {
    await app?.close();
    provider?.closeAllConnections();
    if (provider) await new Promise<void>((resolve) => provider.close(() => resolve()));
    await database?.dispose();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });
  async function companion(name: string) {
    const r = await agent
      .post('/api/companions')
      .send({ requestId: randomUUID(), name, initialProfile: '用于记忆浏览验收。' })
      .expect(201);
    return companionDetailSchema.parse(r.body.data);
  }
  async function conversation(ids: string[]) {
    const r = await agent
      .post('/api/conversations')
      .send({
        requestId: randomUUID(),
        title: '浏览验收',
        kind: ids.length === 1 ? 'private' : 'group',
        includeUser: true,
        companions: ids.map((companionId) => ({ companionId, runtimeEpoch: 1 })),
      })
      .expect(201);
    return conversationDetailSchema.parse(r.body.data).conversation;
  }
  async function publish(id: string, text: string) {
    let r = await agent.get(`/api/conversations/${id}`).expect(200);
    const saved = await agent
      .post(`/api/conversations/${id}/messages`)
      .send({
        requestId: randomUUID(),
        speaker: { kind: 'user' },
        expectedConversationVersion: r.body.data.conversation.version,
        text,
      })
      .expect(201);
    const draft = draftMessageSchema.parse(saved.body.data);
    r = await agent.get(`/api/conversations/${id}`).expect(200);
    const result = await agent
      .post(`/api/conversations/${id}/messages/${draft.id}/publish`)
      .send({
        requestId: randomUUID(),
        expectedRevision: draft.revision,
        expectedConversationVersion: r.body.data.conversation.version,
      })
      .expect(201);
    return publishedMessageSchema.parse(result.body.data);
  }
  const preference: MemoryDocument = {
    kind: 'semantic',
    claim: 'preference',
    subject: { kind: 'user', name: null },
    text: '用户喜欢喝茶。',
    reality: 'real',
    storyKey: null,
    epistemic: 'statement',
    eventTime: null,
    validFrom: null,
    validUntil: null,
  };
  async function remember(
    companionId: string,
    conversationId: string,
    text: string,
    change: Record<string, unknown> = {},
  ) {
    const source = await publish(conversationId, text);
    responseValue = {
      actions: [
        {
          action: 'add',
          targetId: null,
          targetVersion: null,
          revisionKind: null,
          document: { ...preference, text },
          reason: '依据用户陈述。',
          ...change,
          evidence: [{ messageId: source.id, contentVersion: 1, quote: text }],
        },
      ],
    };
    const path = `/api/companions/${companionId}/memories`;
    const queued = (
      await agent
        .post(`${path}/organize`)
        .send({ requestId: randomUUID(), runtimeEpoch: 1, conversationId })
        .expect(201)
    ).body.data;
    await app.get(TaskWorkerService).start();
    await expect
      .poll(async () => (await agent.get(`/api/tasks/${queued.taskId}`)).body.data.status, {
        timeout: 7000,
      })
      .toBe('succeeded');
    await app.get(TaskWorkerService).stop();
    const list = memoryListSchema.parse(
      (await agent.get(path).query({ runtimeEpoch: 1, conversationId }).expect(200)).body.data,
    );
    return { source, items: list.items };
  }
  it('按伴侣汇总自己的私聊，单独选择群聊且不混入其他伴侣', async () => {
    const a = await companion('浏览 A');
    const b = await companion('浏览 B');
    const first = await conversation([a.id]);
    const second = await conversation([a.id]);
    const other = await conversation([b.id]);
    const group = await conversation([a.id, b.id]);
    await remember(a.id, first.id, '喜欢绿茶。');
    await remember(a.id, second.id, '喜欢听雨。');
    await remember(b.id, other.id, '只属于 B 的认识。');
    await remember(a.id, group.id, '共同讨论过旅行。');
    const scopes = (
      await agent
        .get(`/api/companions/${a.id}/memory-explorer/conversations`)
        .query({ runtimeEpoch: 1 })
        .expect(200)
    ).body.data;
    expect(scopes.items.map((item: { id: string }) => item.id).sort()).toEqual(
      [first.id, second.id, group.id].sort(),
    );
    const path = `/api/companions/${a.id}/memory-explorer/entries`;
    const all = (await agent.get(path).query({ runtimeEpoch: 1 }).expect(200)).body.data;
    expect(
      all.items.map((item: { document: MemoryDocument }) => item.document.text).sort(),
    ).toEqual(['喜欢听雨。', '喜欢绿茶。']);
    const scoped = (
      await agent.get(path).query({ runtimeEpoch: 1, conversationId: group.id }).expect(200)
    ).body.data;
    expect(scoped.items.map((item: { document: MemoryDocument }) => item.document.text)).toEqual([
      '共同讨论过旅行。',
    ]);
    await agent.get(path).query({ runtimeEpoch: 1, conversationId: other.id }).expect(404);
    await agent.get(path).query({ runtimeEpoch: 2 }).expect(409);
    await request(app.getHttpServer()).get(path).query({ runtimeEpoch: 1 }).expect(401);
  }, 30000);
  it('组合文字、状态、类型和创作范围筛选，只返回当前认识并保留来源', async () => {
    const a = await companion('筛选');
    const c = await conversation([a.id]);
    const first = await remember(a.id, c.id, '原来住杭州。', {
      document: { ...preference, claim: 'fact', text: '用户住杭州。' },
    });
    const id = first.items[0]!.id;
    await remember(a.id, c.id, '现在搬到苏州。', {
      action: 'revise',
      targetId: id,
      targetVersion: 1,
      revisionKind: 'change',
      document: {
        ...preference,
        claim: 'fact',
        text: '用户住苏州。',
        eventTime: '昨天',
        validFrom: '昨天',
      },
    });
    await remember(a.id, c.id, '故事中住在月亮。', {
      document: {
        ...preference,
        kind: 'narrative',
        claim: 'creative_setting',
        text: '故事主角住在月亮。',
        reality: 'fictional',
        storyKey: '月之旅',
        epistemic: 'setting',
      },
    });
    const path = `/api/companions/${a.id}/memory-explorer/entries`;
    const filtered = (
      await agent
        .get(path)
        .query({
          runtimeEpoch: 1,
          q: '苏州',
          kind: 'semantic',
          claim: 'fact',
          status: 'active',
          reality: 'real',
        })
        .expect(200)
    ).body.data;
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]).toMatchObject({
      id,
      version: 2,
      isCurrent: true,
      conversationId: c.id,
      operation: 'change',
      document: { eventTime: '昨天' },
    });
    expect(
      (await agent.get(path).query({ runtimeEpoch: 1, q: '杭州' }).expect(200)).body.data.items,
    ).toEqual([]);
    expect(
      (await agent.get(path).query({ runtimeEpoch: 1, q: '%' }).expect(200)).body.data.items,
    ).toEqual([]);
    const story = (
      await agent
        .get(path)
        .query({ runtimeEpoch: 1, reality: 'fictional', storyKey: '月之旅' })
        .expect(200)
    ).body.data;
    expect(story.items).toHaveLength(1);
    const source = await agent
      .get(`/api/companions/${a.id}/sources/${first.source.id}`)
      .query({ runtimeEpoch: 1, contentVersion: 1 })
      .expect(200);
    expect(source.body.data.text).toBe('原来住杭州。');
    await agent
      .get(path)
      .query({
        runtimeEpoch: 1,
        from: '2026-10-31T00:00:00.000Z',
        until: '2026-10-01T00:00:00.000Z',
      })
      .expect(400);
    await agent.get(path).query({ runtimeEpoch: 1, limit: 51 }).expect(400);
  }, 30000);
  it('时间线保留变化、纠错与原有时间精度，分页固定上界且与当前列表分开', async () => {
    const a = await companion('时间线');
    const c = await conversation([a.id]);
    const first = await remember(a.id, c.id, '小时候喜欢喝茶。', {
      document: { ...preference, eventTime: '小时候' },
    });
    const id = first.items[0]!.id;
    await remember(a.id, c.id, '现在改喝咖啡。', {
      action: 'revise',
      targetId: id,
      targetVersion: 1,
      revisionKind: 'change',
      document: { ...preference, text: '现在喝咖啡。', validFrom: '现在' },
    });
    await remember(a.id, c.id, '刚才说错了，是喝水。', {
      action: 'revise',
      targetId: id,
      targetVersion: 2,
      revisionKind: 'correction',
      document: { ...preference, text: '现在喝水。' },
    });
    const path = `/api/companions/${a.id}/memory-explorer/timeline`;
    const page1 = (await agent.get(path).query({ runtimeEpoch: 1, limit: 1 }).expect(200)).body
      .data;
    expect(page1.items[0]).toMatchObject({
      id,
      version: 3,
      isCurrent: true,
      operation: 'correction',
    });
    await remember(a.id, c.id, '又说只喝咖啡。', {
      action: 'conflict',
      targetId: id,
      targetVersion: 3,
      document: { ...preference, text: '仍然喝咖啡。' },
    });
    const page2 = (
      await agent
        .get(path)
        .query({ runtimeEpoch: 1, limit: 1, cursor: page1.nextCursor })
        .expect(200)
    ).body.data;
    expect(page2.asOf).toBe(page1.asOf);
    expect(page2.items[0]).toMatchObject({
      id,
      version: 2,
      isCurrent: false,
      status: 'active',
      operation: 'change',
    });
    const page3 = (
      await agent
        .get(path)
        .query({ runtimeEpoch: 1, limit: 1, cursor: page2.nextCursor })
        .expect(200)
    ).body.data;
    expect(page3.items[0]).toMatchObject({ id, version: 1, document: { eventTime: '小时候' } });
    expect(page3.nextCursor).toBeNull();
    const fresh = (await agent.get(path).query({ runtimeEpoch: 1 }).expect(200)).body.data;
    expect(fresh.items.map((item: { operation: string }) => item.operation)).toEqual([
      'conflict',
      'correction',
      'change',
      'add',
    ]);
    const disputed = (
      await agent.get(path).query({ runtimeEpoch: 1, status: 'disputed' }).expect(200)
    ).body.data;
    expect(disputed.items).toHaveLength(1);
    await agent
      .get(path)
      .query({ runtimeEpoch: 1, limit: 1, q: '其他', cursor: page1.nextCursor })
      .expect(400);
    await agent.get(path).query({ runtimeEpoch: 1, cursor: 'invalid' }).expect(400);
  }, 30000);

  it('图谱从实际版本和精确来源展开，区分推测与修订，拒绝其他实例中心', async () => {
    const a = await companion('图谱 A');
    const b = await companion('图谱 B');
    const c = await conversation([a.id]);
    const first = await remember(a.id, c.id, '我喜欢喝茶。');
    const id = first.items[0]!.id;
    const latest = await remember(a.id, c.id, '可能最近更喜欢绿茶。', {
      action: 'merge',
      targetId: id,
      targetVersion: 1,
      document: { ...preference, text: '用户可能更喜欢绿茶。', epistemic: 'inference' },
    });
    const path = `/api/companions/${a.id}/memory-explorer/graph`;
    const root = (
      await agent
        .get(path)
        .query({ runtimeEpoch: 1, centerKind: 'memory', centerId: id, limit: 1 })
        .expect(200)
    ).body.data;
    expect(root.nodes.some((node: { kind: string }) => node.kind === 'memory')).toBe(true);
    expect(root.edges).toHaveLength(1);
    expect(root.nextCursor).toEqual(expect.any(String));
    const second = (
      await agent
        .get(path)
        .query({
          runtimeEpoch: 1,
          centerKind: 'memory',
          centerId: id,
          limit: 1,
          cursor: root.nextCursor,
        })
        .expect(200)
    ).body.data;
    expect(second.edges).toHaveLength(1);
    expect(second.edges[0].id).not.toBe(root.edges[0].id);
    expect(second.nextCursor).toBeNull();
    const version = latest.items[0]!;
    const graph = (
      await agent
        .get(path)
        .query({ runtimeEpoch: 1, centerKind: 'version', centerId: version.versionId })
        .expect(200)
    ).body.data;
    expect(
      graph.nodes.find((node: { id: string }) => node.id === `version:${version.versionId}`),
    ).toMatchObject({ kind: 'version', record: { document: { epistemic: 'inference' } } });
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'merge',
          source: `version:${version.versionId}`,
          target: `version:${first.items[0]!.versionId}`,
        }),
        expect.objectContaining({
          kind: 'quote',
          source: `version:${version.versionId}`,
          target: `message:${latest.source.id}`,
        }),
      ]),
    );
    const quote = graph.edges.find((edge: { kind: string }) => edge.kind === 'quote');
    expect(quote.quote).toBe('可能最近更喜欢绿茶。');
    expect(graph.nodes.length).toBeLessThanOrEqual(50);
    await agent
      .get(`/api/companions/${b.id}/memory-explorer/graph`)
      .query({ runtimeEpoch: 1, centerKind: 'memory', centerId: id })
      .expect(404);
    await agent
      .get(path)
      .query({ runtimeEpoch: 1, centerKind: 'version', centerId: randomUUID() })
      .expect(404);
  }, 30000);

  it('已打开的浏览记录可批量核对，来源删除或重置后旧快照立即失效', async () => {
    const a = await companion('浏览失效');
    const c = await conversation([a.id]);
    const first = await remember(a.id, c.id, '稍后删除的私有内容。');
    const base = `/api/companions/${a.id}/memory-explorer`;
    const page = (await agent.get(`${base}/entries`).query({ runtimeEpoch: 1 }).expect(200)).body
      .data;
    const input = {
      runtimeEpoch: 1,
      references: page.items.map((item: { versionId: string; readStamp: string }) => ({
        versionId: item.versionId,
        stamp: item.readStamp,
      })),
    };
    expect((await agent.post(`${base}/validate`).send(input).expect(200)).body.data.valid).toBe(
      true,
    );
    const conversationVersion = (await agent.get(`/api/conversations/${c.id}`)).body.data
      .conversation.version;
    const operation = (
      await agent
        .post('/api/lifecycle')
        .send({
          requestId: randomUUID(),
          kind: 'delete_messages',
          conversationId: c.id,
          expectedVersion: conversationVersion,
          messages: [{ messageId: first.source.id, contentVersion: 1 }],
        })
        .expect(201)
    ).body.data;
    expect((await agent.post(`${base}/validate`).send(input).expect(200)).body.data.valid).toBe(
      false,
    );
    await agent
      .get(`${base}/graph`)
      .query({ runtimeEpoch: 1, centerKind: 'memory', centerId: first.items[0]!.id })
      .expect(404);
    await app.get(TaskWorkerService).start();
    await expect
      .poll(async () => (await agent.get(`/api/lifecycle/${operation.id}`)).body.data.completedAt, {
        timeout: 10000,
      })
      .not.toBeNull();
    await app.get(TaskWorkerService).stop();
    const cleared = (await agent.get(`${base}/timeline`).query({ runtimeEpoch: 1 }).expect(200))
      .body.data;
    expect(cleared.items[0]).toMatchObject({ status: 'invalidated', document: null, reason: null });
    const graph = (
      await agent
        .get(`${base}/graph`)
        .query({ runtimeEpoch: 1, centerKind: 'version', centerId: first.items[0]!.versionId })
        .expect(200)
    ).body.data;
    expect(graph.edges).toEqual([]);
    expect(JSON.stringify(graph)).not.toContain('稍后删除的私有内容');
    expect((await agent.post(`${base}/validate`).send(input).expect(200)).body.data.valid).toBe(
      false,
    );
    const state = (await agent.get(`/api/companions/${a.id}`)).body.data;
    await agent
      .post('/api/lifecycle')
      .send({
        requestId: randomUUID(),
        kind: 'reset_companion',
        companionId: a.id,
        runtimeEpoch: 1,
        expectedVersion: state.version,
      })
      .expect(201);
    await agent.post(`${base}/validate`).send(input).expect(409);
    await agent.get(`${base}/entries`).query({ runtimeEpoch: 1 }).expect(409);
  }, 30000);
});
