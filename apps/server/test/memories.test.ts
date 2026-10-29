import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { memoryConfigurationSchema } from '@memory-weave/contracts';
import type { ServerConfig } from '../src/config';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { loadServerConfig } from '../src/config';
import { randomUUID } from 'node:crypto';
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
} from '@memory-weave/contracts';
import { createApplication } from '../src/app';
import { TaskWorkerService } from '../src/modules/tasks/task-worker.service';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';

describe('批量记忆整理的公开协议', () => {
  let worker: ChildProcess | undefined;
  let heldResponse: ServerResponse | undefined;
  let holdResponse = false;
  let config: ServerConfig;
  let provider: Server | undefined;
  let responseValue: unknown;
  let calls = 0;
  let app: INestApplication;
  let database: TestDatabase;
  let dataDir: string;
  let agent: ReturnType<typeof request.agent>;
  beforeEach(async () => {
    database = await createTestDatabase();
    dataDir = await mkdtemp(join(tmpdir(), 'memory-weave-memory-'));
    config = {
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      qdrantUrl: 'http://127.0.0.1:1',
      qdrantApiKey: 'test-vector-key',
      adminPassword: 'memory-test-password',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir,
      webDistDir: null,
    };
    holdResponse = false;
    heldResponse = undefined;
    app = await createApplication(config);
    agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: 'memory-test-password' }).expect(200);
  });
  afterEach(async () => {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, 'exit');
      worker.kill('SIGKILL');
      await exited;
    }
    worker = undefined;
    provider?.closeAllConnections();
    await app?.close();
    if (provider) {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider!.close(() => resolve()));
      provider = undefined;
    }
    await database?.dispose();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });
  async function companion(name: string) {
    const r = await agent
      .post('/api/companions')
      .send({ requestId: randomUUID(), name, initialProfile: '用于记忆验收的初始设定。' })
      .expect(201);
    return companionDetailSchema.parse(r.body.data);
  }
  async function conversation(ids: string[]) {
    const r = await agent
      .post('/api/conversations')
      .send({
        requestId: randomUUID(),
        title: '记忆批次',
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
        expectedConversationVersion: conversationDetailSchema.parse(r.body.data).conversation
          .version,
        text,
      })
      .expect(201);
    const draft = draftMessageSchema.parse(saved.body.data);
    r = await agent.get(`/api/conversations/${id}`).expect(200);
    const published = await agent
      .post(`/api/conversations/${id}/messages/${draft.id}/publish`)
      .send({
        requestId: randomUUID(),
        expectedRevision: draft.revision,
        expectedConversationVersion: conversationDetailSchema.parse(r.body.data).conversation
          .version,
      })
      .expect(201);
    return publishedMessageSchema.parse(published.body.data);
  }
  it('一次批次处理多条闲聊，零条目也完成，不能代替其他实例的进度', async () => {
    const a = await companion('记忆 A');
    const b = await companion('记忆 B');
    const c = await conversation([a.id, b.id]);
    await publish(c.id, '早上好。');
    await publish(c.id, '嗯，今天就随便聊聊。');
    const path = `/api/companions/${a.id}/memories`;
    const command = { requestId: randomUUID(), runtimeEpoch: 1, conversationId: c.id };
    const queued = await agent.post(`${path}/organize`).send(command).expect(201);
    await agent
      .post(`${path}/organize`)
      .send(command)
      .expect(201)
      .expect((r) => expect(r.body.data).toEqual(queued.body.data));
    await app.get(TaskWorkerService).start();
    await expect
      .poll(
        async () => {
          const r = await agent
            .get(`${path}/batches`)
            .query({ runtimeEpoch: 1, conversationId: c.id })
            .expect(200);
          return r.body.data.items[0]?.status;
        },
        { timeout: 7000 },
      )
      .toBe('succeeded');
    await app.get(TaskWorkerService).stop();
    const state = await agent
      .get(path)
      .query({ runtimeEpoch: 1, conversationId: c.id })
      .expect(200);
    expect(state.body.data.items).toEqual([]);
    const progress = await agent
      .get(`/api/companions/${a.id}/conversations/${c.id}/progress`)
      .query({ runtimeEpoch: 1 })
      .expect(200);
    expect(progress.body.data.items.map((x: { processing: string }) => x.processing)).toEqual([
      'processed',
      'processed',
    ]);
    const other = await agent
      .get(`/api/companions/${b.id}/conversations/${c.id}/progress`)
      .query({ runtimeEpoch: 1 })
      .expect(200);
    expect(other.body.data.items.map((x: { processing: string }) => x.processing)).toEqual([
      'pending',
      'pending',
    ]);
  });
  async function useProvider() {
    calls = 0;
    provider = createServer((_req, res) => {
      calls++;
      if (holdResponse) {
        heldResponse = res;
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          model: 'memory-fixture',
          choices: [{ message: { content: JSON.stringify(responseValue) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 30, completion_tokens: 70 },
        }),
      );
    });
    await new Promise<void>((resolve) => provider!.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('fixture 未启动');
    await app.close();
    config = loadServerConfig({
      DATABASE_URL: database.databaseUrl,
      ADMIN_PASSWORD: 'memory-test-password',
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
    });
    app = await createApplication(config);
    agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: 'memory-test-password' }).expect(200);
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
        evaluationNote: '隔离协议测试，不评价真实模型语义。',
      })
      .expect(200);
  }
  it('自动采用新增，保留精确证据；同一内容重复出现只补来源，不复制记忆', async () => {
    await useProvider();
    const a = await companion('有记忆的 A');
    const c = await conversation([a.id]);
    const source = await publish(c.id, '我喜欢喝茶。');
    const document = {
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
    responseValue = {
      actions: [
        {
          action: 'add',
          targetId: null,
          targetVersion: null,
          revisionKind: null,
          document,
          reason: '用户明确表达偏好。',
          evidence: [{ messageId: source.id, contentVersion: 1, quote: '我喜欢喝茶。' }],
        },
      ],
    };
    const path = `/api/companions/${a.id}/memories`;
    const first = await agent
      .post(`${path}/organize`)
      .send({ requestId: randomUUID(), runtimeEpoch: 1, conversationId: c.id })
      .expect(201);
    await app.get(TaskWorkerService).start();
    await expect
      .poll(
        async () => (await agent.get(`/api/tasks/${first.body.data.taskId}`)).body.data.status,
        { timeout: 5000 },
      )
      .toBe('succeeded');
    await app.get(TaskWorkerService).stop();
    const list = (
      await agent.get(path).query({ runtimeEpoch: 1, conversationId: c.id }).expect(200)
    ).body.data;
    expect(list.items).toHaveLength(1);
    expect(list.items[0].document.text).toBe('用户喜欢喝茶。');
    expect(list.items[0].version).toBe(1);
    const secondSource = await publish(c.id, '我喜欢喝茶。');
    responseValue = {
      actions: [
        {
          action: 'add',
          targetId: null,
          targetVersion: null,
          revisionKind: null,
          document,
          reason: '再次表达。',
          evidence: [{ messageId: secondSource.id, contentVersion: 1, quote: '我喜欢喝茶。' }],
        },
      ],
    };
    const second = await agent
      .post(`${path}/organize`)
      .send({ requestId: randomUUID(), runtimeEpoch: 1, conversationId: c.id })
      .expect(201);
    await app.get(TaskWorkerService).start();
    await expect
      .poll(
        async () => (await agent.get(`/api/tasks/${second.body.data.taskId}`)).body.data.status,
        { timeout: 5000 },
      )
      .toBe('succeeded');
    await app.get(TaskWorkerService).stop();
    const repeated = (
      await agent.get(path).query({ runtimeEpoch: 1, conversationId: c.id }).expect(200)
    ).body.data;
    expect(repeated.items).toHaveLength(1);
    expect(repeated.items[0].id).toBe(list.items[0].id);
    expect(repeated.items[0].version).toBe(1);
    const detail = (
      await agent
        .get(`${path}/${list.items[0].id}`)
        .query({ runtimeEpoch: 1, conversationId: c.id })
        .expect(200)
    ).body.data;
    expect(detail.versions).toHaveLength(1);
    expect(
      detail.versions[0].evidence.map((e: { messageId: string }) => e.messageId).sort(),
    ).toEqual([source.id, secondSource.id].sort());
    expect(calls).toBe(2);
  });

  const preference = {
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
  async function organizeValue(
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
          document: preference,
          reason: '明确表达。',
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
        timeout: 5000,
      })
      .toBe('succeeded');
    await app.get(TaskWorkerService).stop();
    return {
      source,
      queued,
      items: (await agent.get(path).query({ runtimeEpoch: 1, conversationId }).expect(200)).body
        .data.items,
    };
  }
  it('补充、真实变化、更正与分歧各自保留版本，原文和初始人格不被改写', async () => {
    await useProvider();
    const a = await companion('历史版本');
    const c = await conversation([a.id]);
    const path = `/api/companions/${a.id}/memories`;
    const initial = (await agent.get(`/api/companions/${a.id}/persona`)).body.data;
    const first = await organizeValue(a.id, c.id, '我喜欢喝茶。');
    const id = first.items[0].id;
    await organizeValue(a.id, c.id, '尤其喜欢绿茶。', {
      action: 'merge',
      targetId: id,
      targetVersion: 1,
      document: { ...preference, text: '用户喜欢喝茶，尤其绿茶。' },
    });
    await organizeValue(a.id, c.id, '最近我改喝咖啡了。', {
      action: 'revise',
      targetId: id,
      targetVersion: 2,
      revisionKind: 'change',
      document: { ...preference, text: '用户最近改喝咖啡。', validFrom: '最近' },
    });
    await organizeValue(a.id, c.id, '刚才说错了，我改喝的是白水。', {
      action: 'revise',
      targetId: id,
      targetVersion: 3,
      revisionKind: 'correction',
      document: { ...preference, text: '用户最近改喝白水。', validFrom: '最近' },
    });
    const conflict = await organizeValue(a.id, c.id, '不过我又说自己仍然只喝咖啡。', {
      action: 'conflict',
      targetId: id,
      targetVersion: 4,
      document: { ...preference, text: '用户称仍然只喝咖啡。' },
    });
    expect(conflict.items).toHaveLength(1);
    expect(conflict.items[0].status).toBe('disputed');
    const detail = (
      await agent.get(`${path}/${id}`).query({ runtimeEpoch: 1, conversationId: c.id })
    ).body.data;
    const versions = detail.versions.sort(
      (a: { version: number }, b: { version: number }) => a.version - b.version,
    );
    expect(versions.map((v: { operation: string }) => v.operation)).toEqual([
      'add',
      'merge',
      'change',
      'correction',
      'conflict',
    ]);
    expect(versions[0].document.text).toBe('用户喜欢喝茶。');
    expect(versions[3].document.text).toBe('用户最近改喝白水。');
    expect((await agent.get(`/api/companions/${a.id}/persona`)).body.data).toEqual(initial);
  }, 20000);
  it('伪造来源使整批失败，不能留下前半批条目或跳过待整理范围', async () => {
    await useProvider();
    const a = await companion('拒绝越界');
    const c = await conversation([a.id]);
    const source = await publish(c.id, '我喜欢喝茶。');
    const valid = {
      action: 'add',
      targetId: null,
      targetVersion: null,
      revisionKind: null,
      document: preference,
      reason: '明确表达。',
      evidence: [{ messageId: source.id, contentVersion: 1, quote: '我喜欢喝茶。' }],
    };
    responseValue = {
      actions: [
        valid,
        {
          ...valid,
          document: { ...preference, text: '编造的条目。' },
          evidence: [{ messageId: randomUUID(), contentVersion: 1, quote: '不存在的来源。' }],
        },
      ],
    };
    const path = `/api/companions/${a.id}/memories`;
    const queued = (
      await agent
        .post(`${path}/organize`)
        .send({ requestId: randomUUID(), runtimeEpoch: 1, conversationId: c.id })
        .expect(201)
    ).body.data;
    await app.get(TaskWorkerService).start();
    await expect
      .poll(async () => (await agent.get(`/api/tasks/${queued.taskId}`)).body.data.status, {
        timeout: 5000,
      })
      .toBe('failed');
    await app.get(TaskWorkerService).stop();
    expect(
      (await agent.get(path).query({ runtimeEpoch: 1, conversationId: c.id })).body.data.items,
    ).toEqual([]);
    expect(
      (await agent.get(`/api/companions/${a.id}/conversations/${c.id}/progress?runtimeEpoch=1`))
        .body.data.items[0].processing,
    ).toBe('processing');
    responseValue = { actions: [valid] };
    const retryCommand = { requestId: randomUUID(), runtimeEpoch: 1, conversationId: c.id };
    const retry = (
      await agent.post(`${path}/batches/${queued.id}/retry`).send(retryCommand).expect(201)
    ).body.data;
    await agent
      .post(`${path}/batches/${queued.id}/retry`)
      .send(retryCommand)
      .expect(201)
      .expect((r) => expect(r.body.data).toEqual(retry));
    await app.get(TaskWorkerService).start();
    await expect
      .poll(async () => (await agent.get(`/api/tasks/${retry.taskId}`)).body.data.status, {
        timeout: 5000,
      })
      .toBe('succeeded');
    await app.get(TaskWorkerService).stop();
    expect(
      (await agent.get(path).query({ runtimeEpoch: 1, conversationId: c.id })).body.data.items,
    ).toHaveLength(1);
    expect((await agent.get(`/api/tasks/${queued.taskId}`)).body.data.status).toBe('failed');
  });
  it('删除来源立即限制记忆读取，清理后正文和历史证据失效，其他会话保留', async () => {
    await useProvider();
    const a = await companion('生命周期 A');
    const c = await conversation([a.id]);
    const other = await conversation([a.id]);
    const first = await organizeValue(a.id, c.id, '我喜欢喝茶。');
    await organizeValue(a.id, c.id, '也喜欢绿茶。', {
      action: 'merge',
      targetId: first.items[0].id,
      targetVersion: 1,
      document: { ...preference, text: '用户喜欢喝茶和绿茶。' },
    });
    await organizeValue(a.id, other.id, '我喜欢喝茶。');
    const version = (await agent.get(`/api/conversations/${c.id}`)).body.data.conversation.version;
    const operation = (
      await agent
        .post('/api/lifecycle')
        .send({
          requestId: randomUUID(),
          kind: 'delete_messages',
          conversationId: c.id,
          expectedVersion: version,
          messages: [{ messageId: first.source.id, contentVersion: 1 }],
        })
        .expect(201)
    ).body.data;
    const path = `/api/companions/${a.id}/memories`;
    await agent.get(path).query({ runtimeEpoch: 1, conversationId: c.id }).expect(409);
    await app.get(TaskWorkerService).start();
    await expect
      .poll(async () => (await agent.get(`/api/lifecycle/${operation.id}`)).body.data.status, {
        timeout: 5000,
      })
      .toBe('completed');
    await app.get(TaskWorkerService).stop();
    const detail = (
      await agent
        .get(`${path}/${first.items[0].id}`)
        .query({ runtimeEpoch: 1, conversationId: c.id })
        .expect(200)
    ).body.data;
    expect(detail.current.status).toBe('invalidated');
    expect(detail.current.document).toBeNull();
    expect(detail.versions[0].evidence).toEqual([]);
    expect(detail.versions).toHaveLength(2);
    expect(
      detail.versions.every(
        (item: { document: unknown; evidence: unknown[] }) =>
          item.document === null && item.evidence.length === 0,
      ),
    ).toBe(true);
    const remaining = (
      await agent.get(`/api/companions/${a.id}/conversations/${c.id}/progress?runtimeEpoch=1`)
    ).body.data;
    expect(remaining.items[0].processing).toBe('pending');
    expect(
      (await agent.get(path).query({ runtimeEpoch: 1, conversationId: other.id }).expect(200)).body
        .data.items[0].document.text,
    ).toBe('用户喜欢喝茶。');
  }, 15000);
  it.each([
    ['数量', { messageThreshold: 2, idleMs: 60000, maxWaitMs: 60000 }, 2],
    ['空闲', { messageThreshold: 40, idleMs: 1000, maxWaitMs: 60000 }, 1],
    ['最大等待', { messageThreshold: 40, idleMs: 60000, maxWaitMs: 1000 }, 1],
    ['体积', { messageThreshold: 40, idleMs: 60000, maxWaitMs: 60000, characterThreshold: 100 }, 1],
  ] as const)('达到%s条件后自动组成批次，空队列不调用模型', async (_name, settings, count) => {
    await app.close();
    config = { ...config, memoryConfiguration: memoryConfigurationSchema.parse(settings) };
    app = await createApplication(config);
    agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    await app.get(TaskWorkerService).start();
    await delay(1100);
    expect((await agent.get('/api/models/usage')).body.data.global.charged.requests).toBe(0);
    await app.get(TaskWorkerService).stop();
    const a = await companion('自动整理');
    const c = await conversation([a.id]);
    for (let i = 0; i < count; i++)
      await publish(c.id, '今天的日常随笔。'.repeat(_name === '体积' ? 20 : 1));
    await app.get(TaskWorkerService).start();
    await expect
      .poll(
        async () => {
          const rows = (
            await agent
              .get(`/api/companions/${a.id}/memories/batches`)
              .query({ runtimeEpoch: 1, conversationId: c.id })
          ).body.data.items;
          return rows[0]?.status;
        },
        { timeout: 5000 },
      )
      .toBe('succeeded');
    await app.get(TaskWorkerService).stop();
    expect(
      (
        await agent
          .get(`/api/companions/${a.id}/memories/batches`)
          .query({ runtimeEpoch: 1, conversationId: c.id })
      ).body.data.items[0].sourceCount,
    ).toBe(count);
    expect((await agent.get('/api/models/usage')).body.data.tasks.memory.charged.requests).toBe(1);
  });
  it('模型结果已保存而领域未提交时强杀进程，恢复复用原调用且只形成一份记忆', async () => {
    await useProvider();
    holdResponse = true;
    const a = await companion('恢复记忆');
    const c = await conversation([a.id]);
    const source = await publish(c.id, '我喜欢喝茶。');
    responseValue = {
      actions: [
        {
          action: 'add',
          targetId: null,
          targetVersion: null,
          revisionKind: null,
          document: preference,
          reason: '明确表达。',
          evidence: [{ messageId: source.id, contentVersion: 1, quote: '我喜欢喝茶。' }],
        },
      ],
    };
    const path = `/api/companions/${a.id}/memories`;
    const queued = (
      await agent
        .post(`${path}/organize`)
        .send({ requestId: randomUUID(), runtimeEpoch: 1, conversationId: c.id })
        .expect(201)
    ).body.data;
    const address = provider!.address();
    if (!address || typeof address === 'string') throw new Error('fixture 未启动');
    worker = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./support/task-process.ts', import.meta.url))],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DATABASE_URL: database.databaseUrl,
          ADMIN_PASSWORD: config.adminPassword,
          QDRANT_API_KEY: config.qdrantApiKey,
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
        },
      },
    );
    await expect.poll(() => Boolean(heldResponse), { timeout: 5000 }).toBe(true);
    const paused = (await agent.post(`/api/tasks/${queued.taskId}/pause`).send({}).expect(200)).body
      .data;
    heldResponse!.setHeader('Content-Type', 'application/json');
    heldResponse!.end(
      JSON.stringify({
        model: 'memory-fixture',
        choices: [{ message: { content: JSON.stringify(responseValue) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 70 },
      }),
    );
    await expect
      .poll(
        async () => (await agent.get(`/api/models/calls/${paused.modelCallId}`)).body.data.status,
        { timeout: 5000 },
      )
      .toBe('succeeded');
    expect(
      (await agent.get(path).query({ runtimeEpoch: 1, conversationId: c.id })).body.data.items,
    ).toEqual([]);
    const exited = once(worker, 'exit');
    worker.kill('SIGKILL');
    await exited;
    worker = undefined;
    await agent.post(`/api/tasks/${queued.taskId}/resume`).send({}).expect(200);
    await app.get(TaskWorkerService).start();
    await expect
      .poll(async () => (await agent.get(`/api/tasks/${queued.taskId}`)).body.data.status, {
        timeout: 5000,
      })
      .toBe('succeeded');
    await app.get(TaskWorkerService).stop();
    expect(
      (await agent.get(path).query({ runtimeEpoch: 1, conversationId: c.id })).body.data.items,
    ).toHaveLength(1);
    expect((await agent.get(`/api/tasks/${queued.taskId}`)).body.data.attempts).toHaveLength(2);
    expect(calls).toBe(1);
  }, 20000);
  it('超时未知结果重启后仍阻塞，显式重试也不能换身份补发', async () => {
    await useProvider();
    holdResponse = true;
    const current = (await agent.get('/api/models/config')).body.data;
    current.config.tasks.memory.timeoutMs = 1000;
    await agent
      .put('/api/models/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: current.version,
        config: current.config,
        evaluationNote: '验证未知结果边界。',
      })
      .expect(200);
    const a = await companion('未知结果');
    const c = await conversation([a.id]);
    await publish(c.id, '我喜欢喝茶。');
    const path = `/api/companions/${a.id}/memories`;
    const queued = (
      await agent
        .post(`${path}/organize`)
        .send({ requestId: randomUUID(), runtimeEpoch: 1, conversationId: c.id })
        .expect(201)
    ).body.data;
    await app.get(TaskWorkerService).start();
    await expect
      .poll(async () => (await agent.get(`/api/tasks/${queued.taskId}`)).body.data.reason, {
        timeout: 5000,
      })
      .toBe('model_result_unknown');
    await app.close();
    app = await createApplication(config);
    agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    await agent
      .post(`${path}/batches/${queued.id}/retry`)
      .send({ requestId: randomUUID(), runtimeEpoch: 1, conversationId: c.id })
      .expect(409);
    await app.get(TaskWorkerService).start();
    await delay(1100);
    await app.get(TaskWorkerService).stop();
    expect(calls).toBe(1);
  }, 15000);
  it('后台记忆模型等待时，普通聊天仍能领取并完成回复', async () => {
    await useProvider();
    holdResponse = true;
    const a = await companion('边聊边整理');
    const c = await conversation([a.id]);
    const chat = (
      await agent
        .post('/api/chats')
        .send({ requestId: randomUUID(), companionId: a.id, runtimeEpoch: 1, title: '继续聊天' })
        .expect(201)
    ).body.data;
    await publish(c.id, '我喜欢喝茶。');
    await agent
      .post(`/api/companions/${a.id}/memories/organize`)
      .send({ requestId: randomUUID(), runtimeEpoch: 1, conversationId: c.id })
      .expect(201);
    await app.get(TaskWorkerService).start();
    await expect.poll(() => Boolean(heldResponse), { timeout: 4000 }).toBe(true);
    await agent
      .post(`/api/chats/${chat.id}/messages`)
      .send({ requestId: randomUUID(), text: '接着聊天。' })
      .expect(201);
    await expect
      .poll(
        async () => (await agent.get(`/api/chats/${chat.id}`)).body.data.currentRun?.task.status,
        { timeout: 5000 },
      )
      .toBe('succeeded');
    heldResponse!.setHeader('Content-Type', 'application/json');
    heldResponse!.end(
      JSON.stringify({
        model: 'memory-fixture',
        choices: [{ message: { content: '{"actions":[]}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 10 },
      }),
    );
  }, 15000);
  it('重置 A 清理其私有记忆，B 的共同经历、来源与进度保持不变', async () => {
    await useProvider();
    const a = await companion('重置 A');
    const b = await companion('保留 B');
    const c = await conversation([a.id, b.id]);
    const first = await organizeValue(a.id, c.id, '我喜欢喝茶。');
    const bPath = `/api/companions/${b.id}/memories`;
    const queued = (
      await agent
        .post(`${bPath}/organize`)
        .send({ requestId: randomUUID(), runtimeEpoch: 1, conversationId: c.id })
        .expect(201)
    ).body.data;
    await app.get(TaskWorkerService).start();
    await expect
      .poll(async () => (await agent.get(`/api/tasks/${queued.taskId}`)).body.data.status, {
        timeout: 5000,
      })
      .toBe('succeeded');
    await app.get(TaskWorkerService).stop();
    const before = (
      await agent.get(bPath).query({ runtimeEpoch: 1, conversationId: c.id }).expect(200)
    ).body.data;
    const progress = (
      await agent.get(`/api/companions/${b.id}/conversations/${c.id}/progress?runtimeEpoch=1`)
    ).body.data;
    const state = (await agent.get(`/api/companions/${a.id}`)).body.data;
    const operation = (
      await agent
        .post('/api/lifecycle')
        .send({
          requestId: randomUUID(),
          kind: 'reset_companion',
          companionId: a.id,
          runtimeEpoch: 1,
          expectedVersion: state.version,
        })
        .expect(201)
    ).body.data;
    await agent
      .get(`/api/companions/${a.id}/memories`)
      .query({ runtimeEpoch: 1, conversationId: c.id })
      .expect(409);
    await app.get(TaskWorkerService).start();
    await expect
      .poll(async () => (await agent.get(`/api/lifecycle/${operation.id}`)).body.data.status, {
        timeout: 5000,
      })
      .toBe('completed');
    await app.get(TaskWorkerService).stop();
    expect(
      (await agent.get(bPath).query({ runtimeEpoch: 1, conversationId: c.id })).body.data,
    ).toEqual(before);
    expect(
      (await agent.get(`/api/companions/${b.id}/conversations/${c.id}/progress?runtimeEpoch=1`))
        .body.data,
    ).toEqual(progress);
    const original = (
      await agent
        .get(`/api/companions/${b.id}/sources/${first.source.id}?runtimeEpoch=1&contentVersion=1`)
        .expect(200)
    ).body.data;
    expect(original.text).toBe('我喜欢喝茶。');
    expect((await agent.get(`/api/companions/${a.id}`)).body.data.initialSnapshot).toEqual(
      state.initialSnapshot,
    );
  }, 15000);
  it('模型在途时删除原文，迟到候选不能形成记忆，用量仍保留', async () => {
    await useProvider();
    holdResponse = true;
    const a = await companion('迟到记忆');
    const c = await conversation([a.id]);
    const source = await publish(c.id, '我喜欢喝茶。');
    const path = `/api/companions/${a.id}/memories`;
    responseValue = {
      actions: [
        {
          action: 'add',
          targetId: null,
          targetVersion: null,
          revisionKind: null,
          document: preference,
          reason: '明确表达。',
          evidence: [{ messageId: source.id, contentVersion: 1, quote: '我喜欢喝茶。' }],
        },
      ],
    };
    const queued = (
      await agent
        .post(`${path}/organize`)
        .send({ requestId: randomUUID(), runtimeEpoch: 1, conversationId: c.id })
        .expect(201)
    ).body.data;
    await app.get(TaskWorkerService).start();
    await expect.poll(() => Boolean(heldResponse), { timeout: 4000 }).toBe(true);
    const before = (await agent.get(`/api/tasks/${queued.taskId}`)).body.data;
    const version = (await agent.get(`/api/conversations/${c.id}`)).body.data.conversation.version;
    const op = (
      await agent
        .post('/api/lifecycle')
        .send({
          requestId: randomUUID(),
          kind: 'delete_messages',
          conversationId: c.id,
          expectedVersion: version,
          messages: [{ messageId: source.id, contentVersion: 1 }],
        })
        .expect(201)
    ).body.data;
    await expect
      .poll(async () => (await agent.get(`/api/lifecycle/${op.id}`)).body.data.status, {
        timeout: 5000,
      })
      .toBe('completed');
    heldResponse!.setHeader('Content-Type', 'application/json');
    heldResponse!.end(
      JSON.stringify({
        model: 'memory-fixture',
        choices: [{ message: { content: JSON.stringify(responseValue) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 70 },
      }),
    );
    await expect
      .poll(
        async () =>
          (await agent.get(`/api/models/calls/${before.modelCallId}`)).body.data.attempts[0]
            .usageSource,
        { timeout: 5000 },
      )
      .toBe('reported');
    await app.get(TaskWorkerService).stop();
    expect(
      (await agent.get(`/api/models/calls/${before.modelCallId}`)).body.data.result,
    ).toBeNull();
    expect(
      (await agent.get(path).query({ runtimeEpoch: 1, conversationId: c.id })).body.data.items,
    ).toEqual([]);
    expect((await agent.get('/api/models/usage')).body.data.tasks.memory.charged.requests).toBe(1);
  }, 15000);
});
