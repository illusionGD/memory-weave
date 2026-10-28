import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { ModelRuntimeService } from '../src/modules/models/model-runtime.service';
import { TaskWorkerService } from '../src/modules/tasks/task-worker.service';
import { loadServerConfig } from '../src/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { TasksService } from '../src/modules/tasks/tasks.service';
import { createApplication } from '../src/app';
import type { ServerConfig } from '../src/config';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';

describe('持久任务的公开控制与恢复边界', () => {
  let app: INestApplication;
  let config: ServerConfig;
  let database: TestDatabase;
  let dataDir: string;
  let child: ChildProcess | undefined;
  let provider: Server | undefined;

  beforeEach(async () => {
    database = await createTestDatabase();
    dataDir = await mkdtemp(join(tmpdir(), 'memory-weave-tasks-'));
    config = {
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      qdrantUrl: process.env.TEST_QDRANT_URL ?? 'http://127.0.0.1:1',
      qdrantApiKey: process.env.TEST_QDRANT_API_KEY ?? 'test-vector-key',
      adminPassword: 'tasks-test-password',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir,
      webDistDir: null,
    };
    app = await createApplication(config);
  });

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    child = undefined;
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

  async function fastLeases(agent: Awaited<ReturnType<typeof login>>) {
    const current = (await agent.get('/api/tasks/config')).body.data;
    await agent
      .put('/api/tasks/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: current.version,
        config: {
          ...current.config,
          leaseMs: 1000,
          attemptTimeoutMs: 5000,
          retryBaseMs: 100,
          pollMs: 100,
        },
      })
      .expect(200);
  }

  async function waitTask(agent: Awaited<ReturnType<typeof login>>, id: string, status: string) {
    for (let i = 0; i < 120; i += 1) {
      const row = (await agent.get(`/api/tasks/${id}`).expect(200)).body.data;
      if (row.status === status) return row;
      await delay(50);
    }
    throw new Error(`测试任务没有进入 ${status}。`);
  }

  async function spawnWorker(mode: 'checkpoint' | 'worker') {
    const definition = config.modelDeployment?.providers[0];
    child = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./support/task-process.ts', import.meta.url))],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DATABASE_URL: config.databaseUrl,
          ADMIN_PASSWORD: config.adminPassword,
          QDRANT_URL: config.qdrantUrl,
          QDRANT_API_KEY: config.qdrantApiKey,
          DATA_DIR: dataDir,
          TASK_TEST_MODE: mode,
          MODEL_PROVIDERS_JSON: JSON.stringify(
            definition
              ? [
                  {
                    id: 'fixture',
                    baseUrl: definition.baseUrl,
                    apiKeyEnv: null,
                    capabilities: ['text'],
                  },
                ]
              : [],
          ),
        },
      },
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('测试 worker 启动超时。')), 5000);
      child!.once('error', () => {
        clearTimeout(timer);
        reject(new Error('测试 worker 启动失败。'));
      });
      child!.stdout!.once('data', () => {
        clearTimeout(timer);
        resolve();
      });
      child!.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('测试 worker 提前退出。'));
      });
    });
  }

  async function killWorker() {
    const exited = once(child!, 'exit');
    child!.kill('SIGKILL');
    await exited;
    child = undefined;
  }

  async function connectProvider(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    provider = createServer(handler);
    await new Promise<void>((resolve) => provider!.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('测试供应商未启动。');
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
          capabilities: ['text'],
        },
      ]),
    });
    app = await createApplication(config);
    const agent = await login();
    const current = (await agent.get('/api/models/config')).body.data;
    Object.assign(current.config.tasks.chat, {
      providerId: 'fixture',
      model: 'fixed-task-v1',
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
      timeoutMs: 1000,
    });
    const version = (
      await agent
        .put('/api/models/config')
        .send({
          requestId: randomUUID(),
          expectedVersion: current.version,
          config: current.config,
          evaluationNote: '本地故障注入，仅验证恢复协议。',
        })
        .expect(200)
    ).body.data.version;
    await fastLeases(agent);
    return { agent, version };
  }

  it('创建任务幂等且重启后保留排队状态，不同输入不能复用同一身份', async () => {
    await request(app.getHttpServer()).get('/api/tasks').expect(401);
    let agent = await login();
    const input = { requestId: randomUUID(), steps: 3 };
    const created = (await agent.post('/api/tasks/diagnostics').send(input).expect(201)).body.data;
    expect(created).toMatchObject({
      kind: 'diagnostic',
      status: 'queued',
      progress: { completedSteps: 0, totalSteps: 3 },
      attempts: [],
    });
    expect((await agent.post('/api/tasks/diagnostics').send(input).expect(201)).body.data).toEqual(
      created,
    );
    expect(
      (
        await agent
          .post('/api/tasks/diagnostics')
          .send({ ...input, steps: 4 })
          .expect(409)
      ).body.code,
    ).toBe(40901);
    await app.close();
    app = await createApplication(config);
    agent = await login();
    expect((await agent.get(`/api/tasks/${created.id}`).expect(200)).body.data).toEqual(created);
    expect((await agent.get('/api/tasks').expect(200)).body.data.items).toEqual([created]);
  });
  it('调度配置有版本且重启保留，非法租约关系与过期修改均拒绝', async () => {
    let agent = await login();
    const initial = (await agent.get('/api/tasks/config').expect(200)).body.data;
    const command = {
      requestId: randomUUID(),
      expectedVersion: initial.version,
      config: { ...initial.config, enabled: false, leaseMs: 1000, attemptTimeoutMs: 5000 },
    };
    const changed = (await agent.put('/api/tasks/config').send(command).expect(200)).body.data;
    expect(changed).toMatchObject({
      version: 2,
      source: 'deployment',
      config: { enabled: false, leaseMs: 1000 },
    });
    expect((await agent.put('/api/tasks/config').send(command).expect(200)).body.data).toEqual(
      changed,
    );
    await agent
      .put('/api/tasks/config')
      .send({ ...command, requestId: randomUUID() })
      .expect(409);
    await agent
      .put('/api/tasks/config')
      .send({
        ...command,
        requestId: randomUUID(),
        expectedVersion: 2,
        config: { ...command.config, leaseMs: 6000 },
      })
      .expect(400);
    await app.close();
    app = await createApplication(config);
    agent = await login();
    expect((await agent.get('/api/tasks/config').expect(200)).body.data).toEqual(changed);
    expect((await agent.get('/api/tasks/config/versions/1').expect(200)).body.data).toEqual(
      initial,
    );
  });

  it('并发只能领取一次，租约过期后从检查点接管，旧令牌和旧结果均不能提交', async () => {
    const agent = await login();
    const settings = (await agent.get('/api/tasks/config')).body.data;
    await agent
      .put('/api/tasks/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: settings.version,
        config: { ...settings.config, leaseMs: 1000, attemptTimeoutMs: 5000, retryBaseMs: 100 },
      })
      .expect(200);
    const created = (
      await agent
        .post('/api/tasks/diagnostics')
        .send({ requestId: randomUUID(), steps: 3 })
        .expect(201)
    ).body.data;
    const runtime = app.get(TasksService);
    const claims = await Promise.all([runtime.claim(), runtime.claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const original = claims.find(Boolean)!;
    await runtime.checkpoint(original, { completedSteps: 1, stage: 'steps' });
    await delay(1100);
    expect(await runtime.claim()).toBeNull();
    await delay(150);
    const successor = (await runtime.claim())!;
    expect(successor.task).toMatchObject({
      id: created.id,
      progress: { completedSteps: 1 },
      attempts: [{ status: 'expired' }, { status: 'running' }],
    });
    await expect(
      runtime.checkpoint(original, { completedSteps: 3, stage: 'steps' }),
    ).rejects.toMatchObject({ code: 40910 });
    await expect(runtime.complete(original)).rejects.toMatchObject({ code: 40910 });
    await runtime.checkpoint(successor, { completedSteps: 3, stage: 'steps' });
    const completed = await runtime.complete(successor);
    expect(completed).toMatchObject({
      status: 'succeeded',
      progress: { completedSteps: 3 },
      attempts: [{ status: 'expired' }, { status: 'succeeded' }],
    });
    expect(await runtime.complete(successor)).toEqual(completed);
    expect(await runtime.claim()).toBeNull();
  });

  it('暂停和取消立即阻止旧提交，恢复保持检查点且取消不可恢复', async () => {
    let agent = await login();
    const runtime = app.get(TasksService);
    const created = (
      await agent.post('/api/tasks/diagnostics').send({ requestId: randomUUID(), steps: 2 })
    ).body.data;
    const lease = (await runtime.claim())!;
    await runtime.checkpoint(lease, { completedSteps: 1, stage: 'steps' });
    await agent.post(`/api/tasks/${created.id}/pause`).send({}).expect(200);
    await expect(runtime.heartbeat(lease)).rejects.toMatchObject({ code: 40910 });
    await expect(runtime.complete(lease)).rejects.toMatchObject({ code: 40910 });
    expect(await runtime.claim()).toBeNull();
    await app.close();
    app = await createApplication(config);
    agent = await login();
    expect((await agent.get(`/api/tasks/${created.id}`)).body.data).toMatchObject({
      status: 'paused',
      progress: { completedSteps: 1 },
    });
    await agent.post(`/api/tasks/${created.id}/resume`).send({}).expect(200);
    const resumed = (await app.get(TasksService).claim())!;
    expect(resumed.task.progress.completedSteps).toBe(1);
    const cancelled = (await agent.post(`/api/tasks/${created.id}/cancel`).send({}).expect(200))
      .body.data;
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      attempts: [{ status: 'paused' }, { status: 'cancelled' }],
    });
    await expect(
      app.get(TasksService).checkpoint(resumed, { completedSteps: 2, stage: 'steps' }),
    ).rejects.toMatchObject({ code: 40910 });
    expect(
      (await agent.post(`/api/tasks/${created.id}/cancel`).send({}).expect(200)).body.data,
    ).toEqual(cancelled);
    await agent.post(`/api/tasks/${created.id}/resume`).send({}).expect(409);
  });

  it('可恢复失败按退避执行，达到累计上限后停止，重启不清零', async () => {
    let agent = await login();
    const settings = (await agent.get('/api/tasks/config')).body.data;
    await agent
      .put('/api/tasks/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: settings.version,
        config: { ...settings.config, maxAttempts: 2, retryBaseMs: 100 },
      })
      .expect(200);
    const created = (
      await agent.post('/api/tasks/diagnostics').send({ requestId: randomUUID(), steps: 1 })
    ).body.data;
    const runtime = app.get(TasksService);
    const lease = (await runtime.claim())!;
    expect(await runtime.fail(lease, 'transient_failure', true)).toMatchObject({
      status: 'waiting',
      reason: 'transient_failure',
      attempts: [{ status: 'failed' }],
    });
    expect(await runtime.claim()).toBeNull();
    await app.close();
    app = await createApplication(config);
    agent = await login();
    await delay(120);
    const next = (await app.get(TasksService).claim())!;
    expect(next.fence).toBe(2);
    await app.get(TasksService).fail(next, 'transient_failure', true);
    expect((await agent.get(`/api/tasks/${created.id}`)).body.data).toMatchObject({
      status: 'failed',
      reason: 'attempt_limit',
      attempts: [{ number: 1 }, { number: 2 }],
    });
    expect(await app.get(TasksService).claim()).toBeNull();
  });

  it('发布原文与 outbox 一起保存，重复发布不重复登记，各伴侣保持独立待整理状态', async () => {
    const agent = await login();
    const companions = [];
    for (const name of ['接收 A', '接收 B']) {
      const row = (
        await agent
          .post('/api/companions')
          .send({ requestId: randomUUID(), name, initialProfile: '任务测试初始设定' })
          .expect(201)
      ).body.data;
      companions.push({ companionId: row.id, runtimeEpoch: row.runtimeEpoch });
    }
    const conversation = (
      await agent
        .post('/api/conversations')
        .send({
          requestId: randomUUID(),
          kind: 'group',
          includeUser: true,
          companions,
          title: '独立处理',
        })
        .expect(201)
    ).body.data.conversation;
    const draft = (
      await agent
        .post(`/api/conversations/${conversation.id}/messages`)
        .send({
          requestId: randomUUID(),
          speaker: { kind: 'user' },
          expectedConversationVersion: 1,
          text: '我搬到杭州了。',
        })
        .expect(201)
    ).body.data;
    const command = {
      requestId: randomUUID(),
      expectedConversationVersion: 1,
      expectedRevision: 1,
    };
    await agent
      .post(`/api/conversations/${conversation.id}/messages/${draft.id}/publish`)
      .send({ ...command, expectedConversationVersion: 2 })
      .expect(409);
    expect((await agent.get('/api/tasks/outbox').expect(200)).body.data.items).toEqual([]);
    await agent
      .post(`/api/conversations/${conversation.id}/messages/${draft.id}/publish`)
      .send(command)
      .expect(201);
    await agent
      .post(`/api/conversations/${conversation.id}/messages/${draft.id}/publish`)
      .send(command)
      .expect(201);
    const pending = (await agent.get('/api/tasks/outbox').expect(200)).body.data.items;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: 'message_published',
      status: 'pending',
      sourceId: draft.id,
    });
    const { TaskOutboxService } = await import('../src/modules/tasks/task-outbox.service');
    await Promise.all([
      app.get(TaskOutboxService).dispatch(),
      app.get(TaskOutboxService).dispatch(),
    ]);
    const jobs = (await agent.get('/api/tasks').expect(200)).body.data.items;
    expect(jobs).toHaveLength(2);
    for (const companion of companions) {
      const owned = jobs.filter(
        (job: { scope: { companionId: string } }) =>
          job.scope.companionId === companion.companionId,
      );
      expect(owned).toHaveLength(1);
      expect(owned[0]).toMatchObject({
        kind: 'memory_extraction',
        status: 'blocked',
        reason: 'handler_unavailable',
        scope: { ...companion, conversationId: conversation.id },
        progress: { completedSteps: 0, totalSteps: null },
        attempts: [],
      });
      expect(
        (await agent.get(`/api/tasks?companionId=${companion.companionId}`)).body.data.items,
      ).toEqual(owned);
    }
    expect((await agent.get('/api/tasks/outbox')).body.data.items[0]).toMatchObject({
      status: 'dispatched',
    });
    expect(await app.get(TasksService).claim()).toBeNull();
    expect((await agent.get('/api/models/usage')).body.data.global.charged.requests).toBe(0);
  });

  it('自动 worker 完成实际步骤，停止后已完成任务不会重新领取', async () => {
    const agent = await login();
    const created = (
      await agent.post('/api/tasks/diagnostics').send({ requestId: randomUUID(), steps: 3 })
    ).body.data;
    const { TaskWorkerService } = await import('../src/modules/tasks/task-worker.service');
    const worker = app.get(TaskWorkerService);
    await worker.start();
    let current;
    for (let i = 0; i < 50; i += 1) {
      current = (await agent.get(`/api/tasks/${created.id}`)).body.data;
      if (current.status === 'succeeded') break;
      await delay(50);
    }
    await worker.stop();
    expect(current).toMatchObject({
      status: 'succeeded',
      progress: { completedSteps: 3 },
      attempts: [{ number: 1, status: 'succeeded' }],
    });
    expect(await app.get(TasksService).claim()).toBeNull();
  });

  it('模型任务使用后台额度且重启重放不再调用模型，任务完成与模型结果分别可查', async () => {
    let agent = await login();
    const modelConfig = (await agent.get('/api/models/config')).body.data;
    const command = {
      requestId: randomUUID(),
      expectedConfigVersion: modelConfig.version,
      role: 'chat',
      operation: 'structured',
      inputText: '后台诊断',
    };
    const created = (await agent.post('/api/tasks/model-probes').send(command).expect(201)).body
      .data;
    const { TaskWorkerService } = await import('../src/modules/tasks/task-worker.service');
    const worker = app.get(TaskWorkerService);
    await worker.start();
    let finished;
    for (let i = 0; i < 50; i += 1) {
      finished = (await agent.get(`/api/tasks/${created.id}`)).body.data;
      if (finished.status === 'succeeded') break;
      await delay(50);
    }
    await worker.stop();
    expect(finished).toMatchObject({
      status: 'succeeded',
      progress: { completedSteps: 1, totalSteps: 1 },
    });
    expect((await agent.get(`/api/models/calls/${finished.modelCallId}`)).body.data).toMatchObject({
      status: 'succeeded',
      lane: 'background',
    });
    expect((await agent.get('/api/models/usage')).body.data.global.charged.requests).toBe(1);
    await app.close();
    app = await createApplication(config);
    agent = await login();
    expect(
      (await agent.post('/api/tasks/model-probes').send(command).expect(201)).body.data,
    ).toEqual(finished);
    expect(await app.get(TasksService).claim()).toBeNull();
    expect((await agent.get('/api/models/usage')).body.data.global.charged.requests).toBe(1);
  });

  it('强制终止已保存检查点的进程，另一个 worker 继续剩余步骤并保留旧尝试', async () => {
    const agent = await login();
    await fastLeases(agent);
    const created = (
      await agent.post('/api/tasks/diagnostics').send({ requestId: randomUUID(), steps: 3 })
    ).body.data;
    await spawnWorker('checkpoint');
    await killWorker();
    expect((await agent.get(`/api/tasks/${created.id}`)).body.data.progress.completedSteps).toBe(1);
    await app.get(TaskWorkerService).start();
    const completed = await waitTask(agent, created.id, 'succeeded');
    await app.get(TaskWorkerService).stop();
    expect(completed).toMatchObject({
      progress: { completedSteps: 3 },
      attempts: [{ status: 'expired' }, { status: 'succeeded' }],
    });
  });

  it('模型结果已保存但任务未提交时恢复复用同一结果，不再占用一次调用额度', async () => {
    let agent = await login();
    await fastLeases(agent);
    const command = {
      requestId: randomUUID(),
      expectedConfigVersion: 1,
      role: 'chat',
      operation: 'text',
      inputText: '结果恢复',
    };
    const created = (await agent.post('/api/tasks/model-probes').send(command)).body.data;
    const lease = (await app.get(TasksService).claim())!;
    if (lease.input.kind !== 'model_probe') throw new Error('任务类型不匹配。');
    const call = await app
      .get(ModelRuntimeService)
      .probe(lease.input.probe, (ownerId, tx) =>
        app.get(TasksService).guardDispatch(ownerId, tx, lease),
      );
    expect(call.status).toBe('succeeded');
    await app.close();
    app = await createApplication(config);
    agent = await login();
    await app.get(TaskWorkerService).start();
    const completed = await waitTask(agent, created.id, 'succeeded');
    await app.get(TaskWorkerService).stop();
    expect(completed).toMatchObject({
      modelCallId: call.id,
      attempts: [{ status: 'expired' }, { status: 'succeeded' }],
    });
    expect((await agent.get('/api/models/usage')).body.data.global.charged.requests).toBe(1);
  });

  it('模型请求发出后进程被强杀，恢复保留未知结果与额度，不自动重新发送', async () => {
    let requests = 0;
    let sent!: () => void;
    const sending = new Promise<void>((resolve) => {
      sent = resolve;
    });
    const { agent, version } = await connectProvider(() => {
      requests += 1;
      sent();
    });
    const created = (
      await agent
        .post('/api/tasks/model-probes')
        .send({
          requestId: randomUUID(),
          expectedConfigVersion: version,
          role: 'chat',
          operation: 'text',
          inputText: '中断请求',
        })
        .expect(201)
    ).body.data;
    await spawnWorker('worker');
    await sending;
    await killWorker();
    await app.get(TaskWorkerService).start();
    const blocked = await waitTask(agent, created.id, 'blocked');
    await app.get(TaskWorkerService).stop();
    expect(blocked).toMatchObject({
      reason: 'model_result_unknown',
      progress: { completedSteps: 0 },
      attempts: [{ status: 'expired' }, { status: 'blocked' }],
    });
    expect((await agent.get(`/api/models/calls/${blocked.modelCallId}`)).body.data).toMatchObject({
      status: 'unknown',
      result: null,
    });
    expect(requests).toBe(1);
    expect((await agent.get('/api/models/usage')).body.data.global.charged.requests).toBe(1);
  }, 15000);
  it('跨进程取消后迟到的模型结果不能恢复任务，但可信用量仍结算', async () => {
    let reply!: ServerResponse;
    let sent!: () => void;
    const sending = new Promise<void>((resolve) => {
      sent = resolve;
    });
    const { agent, version } = await connectProvider((_req, res) => {
      reply = res;
      sent();
    });
    const created = (
      await agent
        .post('/api/tasks/model-probes')
        .send({
          requestId: randomUUID(),
          expectedConfigVersion: version,
          role: 'chat',
          operation: 'text',
          inputText: '迟到结果',
        })
        .expect(201)
    ).body.data;
    await spawnWorker('worker');
    await sending;
    const cancelled = (await agent.post(`/api/tasks/${created.id}/cancel`).send({}).expect(200))
      .body.data;
    expect(cancelled.modelCallId).toEqual(expect.any(String));
    reply.setHeader('content-type', 'application/json');
    reply.end(
      JSON.stringify({
        model: 'fixed-task-v1',
        choices: [{ message: { content: '迟到回复' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      }),
    );
    let call;
    for (let i = 0; i < 50; i += 1) {
      call = (await agent.get(`/api/models/calls/${cancelled.modelCallId}`)).body.data;
      if (call.attempts[0]?.usageSource === 'reported') break;
      await delay(50);
    }
    await killWorker();
    expect(call).toMatchObject({
      status: 'cancelled',
      result: null,
      attempts: [{ usageSource: 'reported', chargedTokens: 14 }],
    });
    expect((await agent.get(`/api/tasks/${created.id}`)).body.data).toMatchObject({
      status: 'cancelled',
      progress: { completedSteps: 0 },
      attempts: [{ status: 'cancelled' }],
    });
  });

  it('取消后即使旧执行者准备调用模型，派发守卫也不会预留额度或发送请求', async () => {
    const agent = await login();
    const created = (
      await agent.post('/api/tasks/model-probes').send({
        requestId: randomUUID(),
        expectedConfigVersion: 1,
        role: 'chat',
        operation: 'text',
        inputText: '取消前置检查',
      })
    ).body.data;
    const lease = (await app.get(TasksService).claim())!;
    if (lease.input.kind !== 'model_probe') throw new Error('任务类型不匹配。');
    await agent.post(`/api/tasks/${created.id}/cancel`).send({}).expect(200);
    await expect(
      app
        .get(ModelRuntimeService)
        .probe(lease.input.probe, (ownerId, tx) =>
          app.get(TasksService).guardDispatch(ownerId, tx, lease),
        ),
    ).rejects.toMatchObject({ code: 40910 });
    expect((await agent.get('/api/models/usage')).body.data.global.charged.requests).toBe(0);
  });

  it('多个应用实例共用并发额度，降低配置不会给在途任务之外增加名额', async () => {
    const agent = await login();
    let current = (await agent.get('/api/tasks/config')).body.data;
    current = (
      await agent.put('/api/tasks/config').send({
        requestId: randomUUID(),
        expectedVersion: current.version,
        config: { ...current.config, maxConcurrent: 2 },
      })
    ).body.data;
    for (let i = 0; i < 3; i += 1)
      await agent
        .post('/api/tasks/diagnostics')
        .send({ requestId: randomUUID(), steps: 1 })
        .expect(201);
    const other = await createApplication(config);
    try {
      const leases = await Promise.all([
        app.get(TasksService).claim(),
        other.get(TasksService).claim(),
        app.get(TasksService).claim(),
      ]);
      expect(leases.filter(Boolean)).toHaveLength(2);
      expect(new Set(leases.filter(Boolean).map((lease) => lease!.task.id)).size).toBe(2);
      await agent
        .put('/api/tasks/config')
        .send({
          requestId: randomUUID(),
          expectedVersion: current.version,
          config: { ...current.config, maxConcurrent: 1 },
        })
        .expect(200);
      const first = leases.find(Boolean)!;
      await app.get(TasksService).checkpoint(first, { completedSteps: 1, stage: 'steps' });
      await app.get(TasksService).complete(first);
      expect(await other.get(TasksService).claim()).toBeNull();
      const second = leases.find((lease) => lease && lease.task.id !== first.task.id)!;
      await other.get(TasksService).checkpoint(second, { completedSteps: 1, stage: 'steps' });
      await other.get(TasksService).complete(second);
      const next = (await app.get(TasksService).claim())!;
      expect(next.task.attempts[0]?.configVersion).toBe(3);
    } finally {
      await other.close();
    }
  });

  it('业务提交抛错时任务完成与后续 outbox 一起回滚，重放成功提交只执行一次回调', async () => {
    const agent = await login();
    const created = (
      await agent.post('/api/tasks/diagnostics').send({ requestId: randomUUID(), steps: 1 })
    ).body.data;
    const runtime = app.get(TasksService);
    const lease = (await runtime.claim())!;
    await runtime.checkpoint(lease, { completedSteps: 1, stage: 'steps' });
    const { stageMessageOutbox } = await import('../src/modules/tasks/task-outbox.service');
    // 故障夹具只登记不存在的来源引用；转交时必须显示来源失效，不能形成记忆。
    const event = {
      conversationId: randomUUID(),
      messageId: randomUUID(),
      contentVersion: 1,
      sequence: 1,
      recipients: [],
    };
    await expect(
      runtime.complete(lease, async (ownerId, tx) => {
        await stageMessageOutbox(ownerId, tx, event);
        throw new Error('注入领域提交中断');
      }),
    ).rejects.toThrow('注入领域提交中断');
    expect((await agent.get(`/api/tasks/${created.id}`)).body.data.status).toBe('running');
    expect((await agent.get('/api/tasks/outbox')).body.data.items).toEqual([]);
    const completed = await runtime.complete(lease, (ownerId, tx) =>
      stageMessageOutbox(ownerId, tx, event),
    );
    expect(completed.status).toBe('succeeded');
    expect((await agent.get('/api/tasks/outbox')).body.data.items).toHaveLength(1);
    expect(
      await runtime.complete(lease, async () => {
        throw new Error('重复执行了已提交回调');
      }),
    ).toEqual(completed);
    const { TaskOutboxService } = await import('../src/modules/tasks/task-outbox.service');
    await app.get(TaskOutboxService).dispatch();
    expect((await agent.get('/api/tasks/outbox')).body.data.items[0]).toMatchObject({
      status: 'blocked',
      reason: 'source_changed',
    });
  });
  it('领域回调执行期间租约到期时整笔提交回滚，不能用事务开始时的检查放行迟到结果', async () => {
    const agent = await login();
    await fastLeases(agent);
    const runtime = app.get(TasksService);
    const created = (
      await agent.post('/api/tasks/diagnostics').send({ requestId: randomUUID(), steps: 1 })
    ).body.data;
    const lease = (await runtime.claim())!;
    await runtime.checkpoint(lease, { completedSteps: 1, stage: 'steps' });
    const { stageMessageOutbox } = await import('../src/modules/tasks/task-outbox.service');
    await expect(
      runtime.complete(lease, async (ownerId, tx) => {
        await stageMessageOutbox(ownerId, tx, {
          conversationId: randomUUID(),
          messageId: randomUUID(),
          contentVersion: 1,
          sequence: 1,
          recipients: [],
        });
        // 模拟异常缓慢的领域提交；正常回调禁止任何外部等待。
        await delay(1100);
      }),
    ).rejects.toMatchObject({ code: 40910 });
    expect((await agent.get('/api/tasks/outbox')).body.data.items).toEqual([]);
    expect((await agent.get(`/api/tasks/${created.id}`)).body.data).toMatchObject({
      status: 'waiting',
      attempts: [{ status: 'expired' }],
    });
  });
});
