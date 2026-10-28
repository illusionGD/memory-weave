import { TaskWorkerService } from '../src/modules/tasks/task-worker.service';
import { setTimeout as delay } from 'node:timers/promises';
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
import { createApplication } from '../src/app';
import type { ServerConfig } from '../src/config';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';

describe('伴侣初始人格的公开命令与查询', () => {
  let app: INestApplication;
  let config: ServerConfig;
  let database: TestDatabase;
  let dataDir: string;
  let provider: Server | undefined;

  beforeEach(async () => {
    database = await createTestDatabase();
    dataDir = await mkdtemp(join(tmpdir(), 'memory-weave-personas-'));
    config = {
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      qdrantUrl: process.env.TEST_QDRANT_URL ?? 'http://127.0.0.1:1',
      qdrantApiKey: process.env.TEST_QDRANT_API_KEY ?? 'test-vector-key',
      adminPassword: 'personas-test-password',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir,
      webDistDir: null,
    };
    app = await createApplication(config);
  });

  afterEach(async () => {
    await app?.close();
    if (provider) {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider!.close(() => resolve()));
      provider = undefined;
    }
    await database?.dispose();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  async function login() {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    return agent;
  }

  async function waitReady(agent: Awaited<ReturnType<typeof login>>, id: string) {
    for (let i = 0; i < 100; i++) {
      const state = (await agent.get(`/api/companions/${id}/persona`).expect(200)).body.data;
      if (state.task.status === 'succeeded') return state;
      await delay(40);
    }
    throw new Error('初始整理没有完成');
  }

  async function connectProvider(respond: (response: ServerResponse) => void) {
    provider = createServer((_req, res) => respond(res));
    await new Promise<void>((resolve) => provider!.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('测试供应商未启动');
    await app.close();
    config = loadServerConfig({
      DATABASE_URL: config.databaseUrl,
      ADMIN_PASSWORD: config.adminPassword,
      QDRANT_URL: config.qdrantUrl,
      QDRANT_API_KEY: config.qdrantApiKey,
      DATA_DIR: dataDir,
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
    const agent = await login();
    const current = (await agent.get('/api/models/config')).body.data;
    Object.assign(current.config.tasks.persona, {
      providerId: 'fixture',
      model: 'persona-fixture',
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
      timeoutMs: 1000,
    });
    await agent
      .put('/api/models/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: current.version,
        config: current.config,
        evaluationNote: '隔离协议测试，不评价真实语义能力。',
      })
      .expect(200);
    return agent;
  }

  function answer(res: ServerResponse, value: unknown) {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: 'persona-fixture',
        choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 70 },
      }),
    );
  }

  async function waitStatus(agent: Awaited<ReturnType<typeof login>>, id: string, status: string) {
    for (let i = 0; i < 100; i++) {
      const state = (await agent.get(`/api/companions/${id}/persona`).expect(200)).body.data;
      if (state.task.status === status) return state;
      await delay(40);
    }
    throw new Error(`初始整理没有进入 ${status}`);
  }

  it('一段人设创建后自动整理；原稿、初始人格和当前版本分别持久保存', async () => {
    let agent = await login();
    const input = {
      requestId: randomUUID(),
      source: {
        kind: 'text',
        profileText: '小夜是旅行记录者，起初慢热，喜欢文学。',
        lockedFeatures: ['保持独立思考'],
      },
    };
    const pending = (await agent.post('/api/companion-creations').send(input).expect(201)).body
      .data;
    expect(pending.companion.initialSnapshot.profileText).toBe(input.source.profileText);
    expect(pending.task).toMatchObject({ kind: 'persona_initialization', status: 'queued' });
    expect(pending.initialPersonaVersion).toBeNull();
    const replay = (await agent.post('/api/companion-creations').send(input).expect(201)).body.data;
    expect(replay.companion.id).toBe(pending.companion.id);
    expect(replay.task.id).toBe(pending.task.id);
    await app.close();
    app = await createApplication(config);
    agent = await login();
    await app.get(TaskWorkerService).start();
    let ready;
    for (let i = 0; i < 100; i++) {
      ready = (await agent.get(`/api/companions/${pending.companion.id}/persona`).expect(200)).body
        .data;
      if (ready.task.status === 'succeeded') break;
      await delay(40);
    }
    expect(ready.task.status).toBe('succeeded');
    expect(ready.companion.initialSnapshot).toEqual(pending.companion.initialSnapshot);
    expect(ready.companion.currentPersonaVersion).toMatchObject({
      version: 2,
      origin: 'initialization',
      mode: 'test',
      document: { name: '测试伴侣', locks: [{ text: '保持独立思考', source: 'explicit' }] },
    });
    expect(ready.initialPersonaVersion).toEqual(ready.companion.currentPersonaVersion);
    expect(
      (
        await agent
          .get(`/api/companions/${pending.companion.id}/persona/versions/1?runtimeEpoch=1`)
          .expect(200)
      ).body.data.profileText,
    ).toBe(input.source.profileText);
    expect((await agent.get('/api/models/usage')).body.data.global.charged.requests).toBe(1);
    await agent
      .post('/api/companion-creations')
      .send({ ...input, name: '不同输入' })
      .expect(409);
  });

  it('管理者修订明确约束只追加当前版本，初始人格与另一实例不受影响', async () => {
    const agent = await login();
    const create = async (name: string) =>
      (
        await agent
          .post('/api/companion-creations')
          .send({
            requestId: randomUUID(),
            name,
            source: { kind: 'text', profileText: '喜欢文学', lockedFeatures: ['保持独立思考'] },
          })
          .expect(201)
      ).body.data;
    const first = await create('小夜');
    const second = await create('小雨');
    await app.get(TaskWorkerService).start();
    const original = await waitReady(agent, first.companion.id);
    const other = await waitReady(agent, second.companion.id);
    const revision = {
      requestId: randomUUID(),
      runtimeEpoch: 1,
      expectedPersonaVersion: 2,
      lockedFeatures: ['保持独立思考', '始终真诚'],
    };
    const path = `/api/companions/${first.companion.id}/persona/locks`;
    const saved = (await agent.post(path).send(revision).expect(201)).body.data;
    expect(saved).toMatchObject({
      version: 3,
      origin: 'lock_revision',
      parentVersionId: original.companion.currentPersonaVersionId,
      modelCallId: null,
    });
    expect(saved.document.locks.map((item: { text: string }) => item.text)).toEqual(
      revision.lockedFeatures,
    );
    expect((await agent.post(path).send(revision).expect(201)).body.data).toEqual(saved);
    await agent
      .post(path)
      .send({ ...revision, requestId: randomUUID() })
      .expect(409);
    await agent
      .post(path)
      .send({ ...revision, lockedFeatures: [] })
      .expect(409);
    const state = (await agent.get(`/api/companions/${first.companion.id}/persona`)).body.data;
    expect(state.initialPersonaVersion).toEqual(original.initialPersonaVersion);
    expect(state.companion.initialSnapshot).toEqual(original.companion.initialSnapshot);
    expect((await agent.get(`/api/companions/${second.companion.id}/persona`)).body.data).toEqual(
      other,
    );
    await agent
      .get(`/api/companions/${second.companion.id}/persona/versions/3?runtimeEpoch=1`)
      .expect(404);
    await agent
      .get(`/api/companions/${first.companion.id}/persona/versions/3?runtimeEpoch=2`)
      .expect(404);
    expect((await agent.get('/api/models/usage')).body.data.global.charged.requests).toBe(2);
  });

  it('模板更新只影响明确选择新版的创建，旧版本与实例保持独立', async () => {
    const agent = await login();
    const template = (
      await agent
        .post('/api/persona-templates')
        .send({
          requestId: randomUUID(),
          name: '初稿模板',
          initialProfile: '小夜喜欢文学',
          lockedFeatures: ['保持直率'],
        })
        .expect(201)
    ).body.data;
    const create = async (version: number) =>
      (
        await agent
          .post('/api/companion-creations')
          .send({
            requestId: randomUUID(),
            source: { kind: 'template', template: { id: template.id, version } },
          })
          .expect(201)
      ).body.data;
    const first = await create(1);
    await agent
      .post(`/api/persona-templates/${template.id}/versions`)
      .send({
        requestId: randomUUID(),
        expectedVersion: 1,
        name: '新稿模板',
        initialProfile: '小夜喜欢旅行',
        lockedFeatures: [],
      })
      .expect(201);
    const old = await create(1);
    const latest = await create(2);
    expect(first.companion.id).not.toBe(old.companion.id);
    expect(old.companion.initialSnapshot.profileText).toBe('小夜喜欢文学');
    expect(latest.companion.initialSnapshot.profileText).toBe('小夜喜欢旅行');
    expect((await agent.get(`/api/companions/${first.companion.id}/persona`)).body.data).toEqual(
      first,
    );
    expect((await agent.get('/api/models/usage')).body.data.global.charged.requests).toBe(0);
  });

  it('旧原稿可显式启用整理；取消保留原稿，主动重试创建新任务且同键不重复', async () => {
    const agent = await login();
    const old = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: '已有伴侣', initialProfile: '喜欢文学' })
        .expect(201)
    ).body.data;
    expect((await agent.get(`/api/companions/${old.id}/persona`)).body.data.task).toBeNull();
    const command = { requestId: randomUUID(), runtimeEpoch: 1, expectedPersonaVersion: 1 };
    const path = `/api/companions/${old.id}/persona/initialize`;
    const first = (await agent.post(path).send(command).expect(201)).body.data;
    await agent.post(`/api/tasks/${first.task.id}/cancel`).expect(200);
    expect(
      (await agent.get(`/api/companions/${old.id}/persona`)).body.data.companion.initialSnapshot,
    ).toEqual(old.initialSnapshot);
    const retry = { ...command, requestId: randomUUID() };
    const next = (await agent.post(path).send(retry).expect(201)).body.data;
    expect(next.task.id).not.toBe(first.task.id);
    expect((await agent.post(path).send(retry).expect(201)).body.data.task.id).toBe(next.task.id);
    await agent
      .post(path)
      .send({ ...retry, requestId: randomUUID() })
      .expect(409);
    await app.get(TaskWorkerService).start();
    const ready = await waitReady(agent, old.id);
    expect(ready.companion.name).toBe('已有伴侣');
    expect((await agent.get(`/api/tasks/${first.task.id}`)).body.data.status).toBe('cancelled');
    expect((await agent.get('/api/models/usage')).body.data.global.charged.requests).toBe(1);
    await agent
      .post(path)
      .send({ ...retry, requestId: randomUUID(), expectedPersonaVersion: 2 })
      .expect(409);
  });

  it('结构化模型结果保留依据，知识不当作爱好，明确约束直接保存原句', async () => {
    const output = {
      name: '小夜',
      core: [{ text: '旅行记录者', evidence: '小夜是旅行记录者' }],
      inclinations: [{ text: '起初慢热', evidence: '起初慢热' }],
      knowledge: [{ text: '尚不了解游戏', evidence: '不懂游戏' }],
      lockedQuotes: ['始终保留独立思考'],
    };
    const agent = await connectProvider((res) => answer(res, output));
    const created = (
      await agent
        .post('/api/companion-creations')
        .send({
          requestId: randomUUID(),
          source: {
            kind: 'text',
            profileText: '小夜是旅行记录者，起初慢热，不懂游戏，希望她始终保留独立思考。',
          },
        })
        .expect(201)
    ).body.data;
    await app.get(TaskWorkerService).start();
    const ready = await waitReady(agent, created.companion.id);
    expect(ready.companion.currentPersonaVersion.document).toEqual({
      schemaVersion: 1,
      sourceKind: 'initial_setting',
      name: '小夜',
      core: output.core,
      inclinations: output.inclinations,
      knowledge: output.knowledge,
      locks: [{ text: '始终保留独立思考', source: 'profile' }],
    });
    expect(ready.companion.currentPersonaVersion.mode).toBe('model');
    const call = (await agent.get(`/api/models/calls/${ready.task.modelCallId}`).expect(200)).body
      .data;
    expect(call.context).toMatchObject({
      kind: 'task',
      companionId: created.companion.id,
      runtimeEpoch: 1,
      conversationId: null,
      promptVersion: 'persona-initial-v1',
    });
  });

  it('模型伪造原稿依据时保留原稿，不采用无依据人格', async () => {
    const agent = await connectProvider((res) =>
      answer(res, {
        name: '小夜',
        core: [{ text: '贵族', evidence: '出生于城堡' }],
        inclinations: [],
        knowledge: [],
        lockedQuotes: [],
      }),
    );
    const created = (
      await agent
        .post('/api/companion-creations')
        .send({ requestId: randomUUID(), source: { kind: 'text', profileText: '喜欢文学' } })
        .expect(201)
    ).body.data;
    await app.get(TaskWorkerService).start();
    const failed = await waitStatus(agent, created.companion.id, 'failed');
    expect(failed.initialPersonaVersion).toBeNull();
    expect(failed.companion.currentPersonaVersion.version).toBe(1);
    expect(failed.task.reason).toBe('api_50201');
    expect(failed.companion.initialSnapshot).toEqual(created.companion.initialSnapshot);
  });

  it('外部调用超时保持未知状态，取消后也不允许换身份自动重发', async () => {
    let calls = 0;
    const agent = await connectProvider(() => {
      calls++;
    });
    const created = (
      await agent
        .post('/api/companion-creations')
        .send({ requestId: randomUUID(), source: { kind: 'text', profileText: '喜欢文学' } })
        .expect(201)
    ).body.data;
    await app.get(TaskWorkerService).start();
    const blocked = await waitStatus(agent, created.companion.id, 'blocked');
    expect(blocked.task.reason).toBe('model_result_unknown');
    await agent.post(`/api/tasks/${blocked.task.id}/cancel`).expect(200);
    await agent
      .post(`/api/companions/${created.companion.id}/persona/initialize`)
      .send({ requestId: randomUUID(), runtimeEpoch: 1, expectedPersonaVersion: 1 })
      .expect(502);
    expect(calls).toBe(1);
    expect(
      (await agent.get(`/api/companions/${created.companion.id}/persona`)).body.data
        .initialPersonaVersion,
    ).toBeNull();
  });

  it('旧诊断占位配置只追加定义绑定，保留模型和限额；并发创建同一命令只产生一个实例任务', async () => {
    const agent = await login();
    const current = (await agent.get('/api/models/config')).body.data;
    Object.assign(current.config.tasks.persona, {
      promptVersion: 'probe-v1',
      schemaVersion: 'probe-v1',
      maxInputTokens: 8192,
      maxOutputTokens: 512,
    });
    const legacy = (
      await agent
        .put('/api/models/config')
        .send({
          requestId: randomUUID(),
          expectedVersion: current.version,
          config: current.config,
          evaluationNote: '模拟 F04 已保存的模型配置。',
        })
        .expect(200)
    ).body.data;
    const input = { requestId: randomUUID(), source: { kind: 'text', profileText: '喜欢文学' } };
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        agent.post('/api/companion-creations').send(input).expect(201),
      ),
    );
    expect(new Set(responses.map((res) => res.body.data.companion.id)).size).toBe(1);
    expect(new Set(responses.map((res) => res.body.data.task.id)).size).toBe(1);
    expect((await agent.get('/api/companions')).body.data.items).toHaveLength(1);
    const activated = (await agent.get('/api/models/config')).body.data;
    expect(activated.version).toBe(legacy.version + 1);
    expect(activated.config).toEqual({
      ...legacy.config,
      tasks: {
        ...legacy.config.tasks,
        persona: {
          ...legacy.config.tasks.persona,
          promptVersion: 'persona-initial-v1',
          schemaVersion: 'persona-initial-v1',
        },
      },
    });
    expect((await agent.get(`/api/models/config/versions/${legacy.version}`)).body.data).toEqual(
      legacy,
    );
    await app.get(TaskWorkerService).start();
    await waitReady(agent, responses[0]!.body.data.companion.id);
    expect((await agent.get('/api/models/usage')).body.data.global.charged.requests).toBe(1);
  });

  it('整理执行中取消后，迟到的模型结果不能采用为人格', async () => {
    let respond: ServerResponse | undefined;
    let arrived!: () => void;
    const sent = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const agent = await connectProvider((res) => {
      respond = res;
      arrived();
    });
    const created = (
      await agent
        .post('/api/companion-creations')
        .send({ requestId: randomUUID(), source: { kind: 'text', profileText: '喜欢文学' } })
        .expect(201)
    ).body.data;
    await app.get(TaskWorkerService).start();
    await sent;
    await agent.post(`/api/tasks/${created.task.id}/cancel`).expect(200);
    answer(respond!, {
      name: '迟到结果',
      core: [],
      inclinations: [],
      knowledge: [],
      lockedQuotes: [],
    });
    await app.get(TaskWorkerService).stop();
    const cancelled = (await agent.get(`/api/companions/${created.companion.id}/persona`)).body
      .data;
    expect(cancelled.task.status).toBe('cancelled');
    expect(cancelled.initialPersonaVersion).toBeNull();
    expect(cancelled.companion.currentPersonaVersion.version).toBe(1);
    expect(cancelled.companion.initialSnapshot).toEqual(created.companion.initialSnapshot);
  });
});
