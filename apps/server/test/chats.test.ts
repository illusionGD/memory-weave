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
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { loadServerConfig } from '../src/config';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { TaskWorkerService } from '../src/modules/tasks/task-worker.service';
import { setTimeout as delay } from 'node:timers/promises';

describe('私聊的公开 HTTP 与事件边界', () => {
  let app: INestApplication;
  let config: ServerConfig;
  let database: TestDatabase;
  let dataDir: string;
  let provider: Server | undefined;
  let secondApp: INestApplication | undefined;
  let worker: ChildProcess | undefined;

  beforeEach(async () => {
    database = await createTestDatabase();
    dataDir = await mkdtemp(join(tmpdir(), 'memory-weave-chats-'));
    config = {
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      qdrantUrl: process.env.TEST_QDRANT_URL ?? 'http://127.0.0.1:1',
      qdrantApiKey: process.env.TEST_QDRANT_API_KEY ?? 'test-vector-key',
      adminPassword: 'chats-test-password',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir,
      webDistDir: null,
    };
    app = await createApplication(config);
  });

  afterEach(async () => {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, 'exit');
      worker.kill('SIGKILL');
      await exited;
    }
    worker = undefined;
    if (provider) provider.closeAllConnections();
    await secondApp?.close();
    secondApp = undefined;
    await app?.close();
    if (provider) await new Promise<void>((resolve) => provider!.close(() => resolve()));
    provider = undefined;
    await database?.dispose();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  async function login() {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    return agent;
  }

  it('当前人格与输入放不进预算时保留原文并明确失败，不截掉约束后偷偷调用', async () => {
    const agent = await login();
    const setting = (await agent.get('/api/models/config').expect(200)).body.data;
    setting.config.tasks.chat.maxInputTokens = 128;
    await agent
      .put('/api/models/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: setting.version,
        config: setting.config,
        evaluationNote: '验证必要上下文的预算边界。',
      })
      .expect(200);
    const companion = (
      await agent
        .post('/api/companions')
        .send({
          requestId: randomUUID(),
          name: '阿澜',
          initialProfile: '保留独立思考。'.repeat(100),
        })
        .expect(201)
    ).body.data;
    const chat = (
      await agent
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          companionId: companion.id,
          runtimeEpoch: 1,
          title: '上下文预算',
        })
        .expect(201)
    ).body.data;
    await agent
      .post(`/api/chats/${chat.id}/messages`)
      .send({ requestId: randomUUID(), text: '你好。' })
      .expect(201);
    await app.get(TaskWorkerService).start();
    let state;
    for (let i = 0; i < 100; i++) {
      state = (await agent.get(`/api/chats/${chat.id}`).expect(200)).body.data;
      if (state.currentRun.status === 'failed') break;
      await delay(30);
    }
    expect(state.currentRun).toMatchObject({
      status: 'failed',
      context: null,
      task: { reason: 'api_40003', modelCallId: null },
    });
    const history = (await agent.get(`/api/chats/${chat.id}/messages`).expect(200)).body.data;
    expect(history.items.map((item: { message: { text: string } }) => item.message.text)).toEqual([
      '你好。',
    ]);
    const usage = (await agent.get('/api/models/usage').expect(200)).body.data;
    expect(usage.tasks.chat.charged.requests).toBe(0);
  });

  it('跨进程取消模型调用后不再发布缓冲中的候选尾句', async () => {
    let response: ServerResponse | undefined;
    provider = createServer((_req, res) => {
      response = res;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'data: {"choices":[{"index":0,"delta":{"content":"已发布。"},"finish_reason":null}]}\n\n',
      );
    });
    await new Promise<void>((resolve) => provider!.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('fixture 未启动');
    await app.close();
    config = loadServerConfig({
      DATABASE_URL: config.databaseUrl,
      ADMIN_PASSWORD: config.adminPassword,
      QDRANT_URL: config.qdrantUrl,
      QDRANT_API_KEY: config.qdrantApiKey,
      DATA_DIR: dataDir,
      CHAT_CONFIG_JSON: JSON.stringify({ publishIntervalMs: 1000 }),
      MODEL_PROVIDERS_JSON: JSON.stringify([
        {
          id: 'fixture',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKeyEnv: null,
          capabilities: ['text'],
          streaming: true,
        },
      ]),
    });
    app = await createApplication(config);
    const agent = await login();
    const setting = (await agent.get('/api/models/config').expect(200)).body.data;
    Object.assign(setting.config.tasks.chat, {
      providerId: 'fixture',
      model: 'stream-test',
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
    });
    await agent
      .put('/api/models/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: setting.version,
        config: setting.config,
        evaluationNote: '取消调用的发布边界验收。',
      })
      .expect(200);
    const companion = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: '阿澜', initialProfile: '喜欢海边。' })
        .expect(201)
    ).body.data;
    const chat = (
      await agent
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          companionId: companion.id,
          runtimeEpoch: 1,
          title: '取消',
        })
        .expect(201)
    ).body.data;
    await agent
      .post(`/api/chats/${chat.id}/messages`)
      .send({ requestId: randomUUID(), text: '你好。' })
      .expect(201);
    await app.get(TaskWorkerService).start();
    let history;
    for (let i = 0; i < 100; i++) {
      history = (await agent.get(`/api/chats/${chat.id}/messages`).expect(200)).body.data;
      if (history.items.length > 1) break;
      await delay(30);
    }
    expect(history.items[1].message.text).toBe('已发布。');
    response!.write(
      'data: {"choices":[{"index":0,"delta":{"content":"尚未发布的尾句。"},"finish_reason":null}]}\n\n',
    );
    await delay(50);
    secondApp = await createApplication(config);
    const other = request.agent(secondApp.getHttpServer());
    await other.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    const state = (await agent.get(`/api/chats/${chat.id}`).expect(200)).body.data;
    await other.post(`/api/models/calls/${state.currentRun.task.modelCallId}/cancel`).expect(200);
    response!.end(
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
    for (let i = 0; i < 100; i++) {
      const updated = (await agent.get(`/api/chats/${chat.id}`).expect(200)).body.data;
      if (updated.currentRun.status === 'failed') break;
      await delay(30);
    }
    history = (await agent.get(`/api/chats/${chat.id}/messages`).expect(200)).body.data;
    expect(history.items.map((item: { message: { text: string } }) => item.message.text)).toEqual([
      '你好。',
      '已发布。',
    ]);
  });

  it('生成进程被终止后保留已发布片段，接管将未知调用阻塞且不换身份重发', async () => {
    let externalRequests = 0;
    provider = createServer((_req, res) => {
      externalRequests++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'data: {"choices":[{"index":0,"delta":{"content":"已经发布的开头。"},"finish_reason":null}]}\n\n',
      );
    });
    await new Promise<void>((resolve) => provider!.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('fixture 未启动');
    const deployment = JSON.stringify([
      {
        id: 'fixture',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKeyEnv: null,
        capabilities: ['text'],
        streaming: true,
      },
    ]);
    const environment = {
      ...process.env,
      DATABASE_URL: config.databaseUrl,
      ADMIN_PASSWORD: config.adminPassword,
      QDRANT_URL: config.qdrantUrl,
      QDRANT_API_KEY: config.qdrantApiKey,
      DATA_DIR: dataDir,
      MODEL_PROVIDERS_JSON: deployment,
    };
    await app.close();
    config = loadServerConfig(environment);
    app = await createApplication(config);
    const agent = await login();
    const modelConfig = (await agent.get('/api/models/config').expect(200)).body.data;
    Object.assign(modelConfig.config.tasks.chat, {
      providerId: 'fixture',
      model: 'stream-test',
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
      timeoutMs: 1500,
    });
    await agent
      .put('/api/models/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: modelConfig.version,
        config: modelConfig.config,
        evaluationNote: '进程故障恢复协议验证。',
      })
      .expect(200);
    const taskConfig = (await agent.get('/api/tasks/config').expect(200)).body.data;
    Object.assign(taskConfig.config, {
      leaseMs: 1000,
      attemptTimeoutMs: 3000,
      pollMs: 100,
      retryBaseMs: 100,
    });
    await agent
      .put('/api/tasks/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: taskConfig.version,
        config: taskConfig.config,
      })
      .expect(200);
    const companion = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: '阿澜', initialProfile: '喜欢海边。' })
        .expect(201)
    ).body.data;
    const chat = (
      await agent
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          companionId: companion.id,
          runtimeEpoch: 1,
          title: '进程恢复',
        })
        .expect(201)
    ).body.data;
    await agent
      .post(`/api/chats/${chat.id}/messages`)
      .send({ requestId: randomUUID(), text: '你好。' })
      .expect(201);
    worker = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./support/task-process.ts', import.meta.url))],
      { stdio: ['ignore', 'pipe', 'pipe'], env: environment },
    );
    let history;
    for (let i = 0; i < 100; i++) {
      history = (await agent.get(`/api/chats/${chat.id}/messages`).expect(200)).body.data;
      if (history.items.length > 1) break;
      await delay(30);
    }
    expect(history.items[1].message.text).toBe('已经发布的开头。');
    const exited = once(worker, 'exit');
    worker.kill('SIGKILL');
    await exited;
    await app.get(TaskWorkerService).start();
    let state;
    for (let i = 0; i < 100; i++) {
      state = (await agent.get(`/api/chats/${chat.id}`).expect(200)).body.data;
      if (state.currentRun.status === 'blocked') break;
      await delay(40);
    }
    expect(state.currentRun).toMatchObject({
      status: 'blocked',
      task: { reason: 'model_result_unknown' },
    });
    expect(externalRequests).toBe(1);
    const call = (
      await agent.get(`/api/models/calls/${state.currentRun.task.modelCallId}`).expect(200)
    ).body.data;
    expect(call).toMatchObject({ status: 'unknown', result: null });
    expect(call.attempts).toHaveLength(1);
    expect(call.attempts[0].usageSource).toBe('reserved');
    const restored = (await agent.get(`/api/chats/${chat.id}/messages`).expect(200)).body.data;
    expect(restored.items.map((item: { message: { text: string } }) => item.message.text)).toEqual([
      '你好。',
      '已经发布的开头。',
    ]);
  }, 15000);

  it('停止命令只作用于指定轮次，聊天会话不能绕过发送入口发布原文', async () => {
    const agent = await login();
    const companion = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: '阿澜', initialProfile: '喜欢海边。' })
        .expect(201)
    ).body.data;
    const chat = (
      await agent
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          companionId: companion.id,
          runtimeEpoch: 1,
          title: '海边',
        })
        .expect(201)
    ).body.data;
    await agent
      .post(`/api/conversations/${chat.id}/messages`)
      .send({
        requestId: randomUUID(),
        speaker: { kind: 'user' },
        expectedConversationVersion: 1,
        text: '绕过打断流程',
      })
      .expect(409);
    const first = (
      await agent
        .post(`/api/chats/${chat.id}/messages`)
        .send({ requestId: randomUUID(), text: '第一句' })
        .expect(201)
    ).body.data;
    await agent.post(`/api/chats/${chat.id}/stop`).send({ runId: first.run.id }).expect(201);
    const second = (
      await agent
        .post(`/api/chats/${chat.id}/messages`)
        .send({ requestId: randomUUID(), text: '第二句' })
        .expect(201)
    ).body.data;
    await agent.post(`/api/chats/${chat.id}/stop`).send({ runId: first.run.id }).expect(201);
    const state = (await agent.get(`/api/chats/${chat.id}`).expect(200)).body.data;
    expect(state.currentRun).toMatchObject({ id: second.run.id, status: 'queued' });
    await agent
      .post(`/api/chats/${chat.id}/deliveries`)
      .send({
        terminalId: randomUUID(),
        messages: [{ messageId: first.message.id, contentVersion: 2 }],
      })
      .expect(404);
  });

  it('事件流按发布游标重连，查询不会冒充送达，显式回执只作用于确切消息', async () => {
    const agent = await login();
    const companion = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: '阿澜', initialProfile: '喜欢海边。' })
        .expect(201)
    ).body.data;
    const chat = (
      await agent
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          companionId: companion.id,
          runtimeEpoch: 1,
          title: '海边',
        })
        .expect(201)
    ).body.data;
    const first = (
      await agent
        .post(`/api/chats/${chat.id}/messages`)
        .send({ requestId: randomUUID(), text: '第一句' })
        .expect(201)
    ).body.data;
    const second = (
      await agent
        .post(`/api/chats/${chat.id}/messages`)
        .send({ requestId: randomUUID(), text: '第二句' })
        .expect(201)
    ).body.data;
    await app.listen(0, '127.0.0.1');
    const auth = await agent
      .post('/api/auth/login')
      .send({ password: config.adminPassword })
      .expect(200);
    const cookie = auth.headers['set-cookie']![0]!.split(';')[0]!;
    const address = await app.getUrl();
    const readOne = async (after: number) => {
      const controller = new AbortController();
      try {
        const response = await fetch(
          `${address}/api/chats/${chat.id}/events?afterSequence=${after}`,
          { headers: { cookie }, signal: controller.signal },
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let text = '';
        while (true) {
          const item = await reader.read();
          if (item.done) throw new Error('没有收到消息事件');
          text += decoder.decode(item.value, { stream: true });
          const frames = text.split('\n\n');
          text = frames.pop()!;
          for (const frame of frames) {
            if (!frame.includes('event: message')) continue;
            const data = JSON.parse(
              frame
                .split('\n')
                .find((line) => line.startsWith('data: '))!
                .slice(6),
            );
            expect(data.code).toBe(200);
            return {
              id: frame
                .split('\n')
                .find((line) => line.startsWith('id: '))!
                .slice(4),
              item: data.data,
            };
          }
        }
      } finally {
        controller.abort();
      }
    };
    const received = await readOne(0);
    expect(received.id).toBe('1');
    expect(received.item).toMatchObject({ message: { id: first.message.id }, deliveredAt: null });
    const replay = await readOne(1);
    expect(replay.item.message.id).toBe(second.message.id);
    let history = (await agent.get(`/api/chats/${chat.id}/messages`).expect(200)).body.data;
    expect(
      history.items.every((item: { deliveredAt: string | null }) => item.deliveredAt === null),
    ).toBe(true);
    const ack = {
      terminalId: randomUUID(),
      messages: [{ messageId: first.message.id, contentVersion: 1 }],
    };
    await agent.post(`/api/chats/${chat.id}/deliveries`).send(ack).expect(201);
    history = (await agent.get(`/api/chats/${chat.id}/messages`).expect(200)).body.data;
    expect(history.items[0].deliveredAt).toEqual(expect.any(String));
    expect(history.items[1].deliveredAt).toBeNull();
    const timestamp = history.items[0].deliveredAt;
    await agent.post(`/api/chats/${chat.id}/deliveries`).send(ack).expect(201);
    history = (await agent.get(`/api/chats/${chat.id}/messages`).expect(200)).body.data;
    expect(history.items[0].deliveredAt).toBe(timestamp);
  });

  it('另一服务进程收到补充后，旧流即使迟到也不能发布，新轮带上已说出的部分', async () => {
    let oldResponse: ServerResponse | undefined;
    const inputs: { messages: { role: string; text: string }[] }[] = [];
    provider = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        const requestBody = JSON.parse(body);
        inputs.push(JSON.parse(requestBody.messages[1].content));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (inputs.length === 1) {
          oldResponse = res;
          res.write(
            'data: {"choices":[{"index":0,"delta":{"content":"上海的路线可以先看"},"finish_reason":null}]}\n\n',
          );
        } else {
          res.end(
            'data: {"choices":[{"index":0,"delta":{"content":"按你补充的杭州来聊。"},"finish_reason":"stop"}],"usage":{"prompt_tokens":40,"completion_tokens":10}}\n\ndata: [DONE]\n\n',
          );
        }
      });
    });
    await new Promise<void>((resolve) => provider!.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('fixture 未启动');
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
          streaming: true,
        },
      ]),
    });
    app = await createApplication(config);
    const agent = await login();
    const setting = (await agent.get('/api/models/config').expect(200)).body.data;
    Object.assign(setting.config.tasks.chat, {
      providerId: 'fixture',
      model: 'stream-test',
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
    });
    await agent
      .put('/api/models/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: setting.version,
        config: setting.config,
        evaluationNote: '流式跨进程协议验收。',
      })
      .expect(200);
    const companion = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: '阿澜', initialProfile: '喜欢散步。' })
        .expect(201)
    ).body.data;
    const chat = (
      await agent
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          companionId: companion.id,
          runtimeEpoch: 1,
          title: '散步',
        })
        .expect(201)
    ).body.data;
    await agent
      .post(`/api/chats/${chat.id}/messages`)
      .send({ requestId: randomUUID(), text: '聊聊上海的路线。' })
      .expect(201);
    await app.get(TaskWorkerService).start();
    let history;
    for (let i = 0; i < 100; i++) {
      history = (await agent.get(`/api/chats/${chat.id}/messages`).expect(200)).body.data;
      if (history.items.length > 1) break;
      await delay(30);
    }
    expect(history.items[1].message.text).toBe('上海的路线可以先看');
    secondApp = await createApplication(config);
    const other = request.agent(secondApp.getHttpServer());
    await other.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    await other
      .post(`/api/chats/${chat.id}/messages`)
      .send({ requestId: randomUUID(), text: '补充一下，我现在在杭州。' })
      .expect(201);
    oldResponse!.end(
      'data: {"choices":[{"index":0,"delta":{"content":"不应该出现的旧尾巴"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
    let state;
    for (let i = 0; i < 100; i++) {
      state = (await agent.get(`/api/chats/${chat.id}`).expect(200)).body.data;
      if (state.currentRun.status === 'succeeded') break;
      await delay(40);
    }
    expect(state.currentRun.status).toBe('succeeded');
    expect(inputs).toHaveLength(2);
    expect(inputs[1]!.messages.map((item) => item.text)).toEqual([
      '聊聊上海的路线。',
      '上海的路线可以先看',
      '补充一下，我现在在杭州。',
    ]);
    history = (await agent.get(`/api/chats/${chat.id}/messages`).expect(200)).body.data;
    expect(history.items.map((item: { message: { text: string } }) => item.message.text)).toEqual([
      '聊聊上海的路线。',
      '上海的路线可以先看',
      '补充一下，我现在在杭州。',
      '按你补充的杭州来聊。',
    ]);
  });

  it('连续补充合并为最新一轮，原文直接进入上下文，回复按真实模型来源发布', async () => {
    const agent = await login();
    const configurationBefore = (await agent.get('/api/models/config').expect(200)).body.data;
    const companion = (
      await agent
        .post('/api/companions')
        .send({
          requestId: randomUUID(),
          name: '阿澜',
          initialProfile: '出生在海边，喜欢散步。',
        })
        .expect(201)
    ).body.data;
    const chat = (
      await agent
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          companionId: companion.id,
          runtimeEpoch: 1,
          title: '当前住址',
        })
        .expect(201)
    ).body.data;
    const first = (
      await agent
        .post(`/api/chats/${chat.id}/messages`)
        .send({ requestId: randomUUID(), text: '我住在上海。' })
        .expect(201)
    ).body.data;
    const second = (
      await agent
        .post(`/api/chats/${chat.id}/messages`)
        .send({ requestId: randomUUID(), text: '补充：已经搬到杭州了。' })
        .expect(201)
    ).body.data;
    await app.get(TaskWorkerService).start();
    let state;
    for (let i = 0; i < 100; i++) {
      state = (await agent.get(`/api/chats/${chat.id}`).expect(200)).body.data;
      if (state.currentRun.status === 'succeeded') break;
      await delay(40);
    }
    expect(state.currentRun).toMatchObject({ id: second.run.id, status: 'succeeded' });
    expect(state.currentRun.context).toMatchObject({
      personaVersionId: companion.currentPersonaVersion.id,
      sources: [
        { messageId: first.message.id, contentVersion: 1 },
        { messageId: second.message.id, contentVersion: 1 },
      ],
      environment: 'web',
    });
    const previous = (await agent.get(`/api/tasks/${first.run.id}`).expect(200)).body.data;
    expect(previous.status).toBe('cancelled');
    const history = (await agent.get(`/api/chats/${chat.id}/messages`).expect(200)).body.data;
    const reply = history.items.filter(
      (item: { runId: string | null }) => item.runId === second.run.id,
    );
    expect(reply.length).toBeGreaterThan(0);
    expect(
      reply.every(
        (item: { message: { state: string; sourceKind: string } }) =>
          item.message.state === 'published' && item.message.sourceKind === 'model_output',
      ),
    ).toBe(true);
    expect(reply.map((item: { message: { text: string } }) => item.message.text).join('')).toBe(
      '测试模型已收到：补充：已经搬到杭州了。',
    );
    const usage = (await agent.get('/api/models/usage').expect(200)).body.data;
    expect(usage.tasks.chat.charged.requests).toBe(1);
    // 新部署已绑定聊天定义，开始聊天不会使其他待执行任务的配置版本过期。
    expect((await agent.get('/api/models/config').expect(200)).body.data.version).toBe(
      configurationBefore.version,
    );
  });

  it('私聊创建与发送重试只保存一份原文，后台未执行也可在重启后继续查询', async () => {
    await request(app.getHttpServer()).get('/api/chats').expect(401);
    let agent = await login();
    const companion = (
      await agent
        .post('/api/companions')
        .send({
          requestId: randomUUID(),
          name: '阿澜',
          initialProfile: '出生在海边，喜欢散步。',
        })
        .expect(201)
    ).body.data;
    const command = {
      requestId: randomUUID(),
      companionId: companion.id,
      runtimeEpoch: 1,
      title: '海边散步',
    };
    const chat = (await agent.post('/api/chats').send(command).expect(201)).body.data;
    expect(chat).toMatchObject({
      companionId: companion.id,
      runtimeEpoch: 1,
      title: '海边散步',
      currentRun: null,
    });
    await agent
      .post('/api/chats')
      .send(command)
      .expect(201)
      .expect((res) => expect(res.body.data.id).toBe(chat.id));
    const input = { requestId: randomUUID(), text: '我现在搬到杭州了。' };
    const sent = (await agent.post(`/api/chats/${chat.id}/messages`).send(input).expect(201)).body
      .data;
    expect(sent.message).toMatchObject({
      text: input.text,
      state: 'published',
      sequence: 1,
      sourceKind: 'user_input',
    });
    expect(sent.run).toMatchObject({ status: 'queued' });
    await agent
      .post(`/api/chats/${chat.id}/messages`)
      .send(input)
      .expect(201)
      .expect((res) => expect(res.body.data.message.id).toBe(sent.message.id));
    await agent
      .post(`/api/chats/${chat.id}/messages`)
      .send({ ...input, text: '改成别的内容' })
      .expect(409);
    await app.close();
    app = await createApplication(config);
    agent = await login();
    const history = (await agent.get(`/api/chats/${chat.id}/messages`).expect(200)).body.data;
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      message: { id: sent.message.id, text: input.text },
      deliveredAt: null,
    });
    const restored = (await agent.get(`/api/chats/${chat.id}`).expect(200)).body.data;
    expect(restored.currentRun.id).toBe(sent.run.id);
    const raw = (await agent.get(`/api/conversations/${chat.id}/messages`).expect(200)).body.data;
    expect(raw.items.map((item: { id: string }) => item.id)).toEqual([sent.message.id]);
  });
});
