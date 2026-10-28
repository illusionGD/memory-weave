import type { ModelConfiguration } from '@memory-weave/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../src/app';
import type { ServerConfig } from '../src/config';
import { loadServerConfig } from '../src/config';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { ModelRuntimeService } from '../src/modules/models/model-runtime.service';

describe('模型配置和调用的公开 HTTP 边界', () => {
  let app: INestApplication;
  let config: ServerConfig;
  let database: TestDatabase;
  let dataDir: string;
  let provider: Server | undefined;
  let worker: ChildProcess | undefined;

  beforeEach(async () => {
    database = await createTestDatabase();
    dataDir = await mkdtemp(join(tmpdir(), 'memory-weave-models-'));
    config = {
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      qdrantUrl: process.env.TEST_QDRANT_URL ?? 'http://127.0.0.1:1',
      qdrantApiKey: process.env.TEST_QDRANT_API_KEY ?? 'test-vector-key',
      adminPassword: 'models-test-password',
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
    await app?.close();
    if (provider) {
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        provider!.close((error) => (error ? reject(error) : resolve())),
      );
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
          apiKeyEnv: 'MODEL_FIXTURE_KEY',
          capabilities: ['text', 'structured', 'embedding'],
        },
      ]),
      MODEL_FIXTURE_KEY: 'private-fixture-key',
    });
    app = await createApplication(config);
    return login();
  }

  async function useProvider(
    agent: Awaited<ReturnType<typeof login>>,
    amend?: (value: ModelConfiguration) => void,
  ) {
    const current = (await agent.get('/api/models/config').expect(200)).body.data;
    current.config.tasks.chat.providerId = 'fixture';
    current.config.tasks.chat.model = 'fixed-model-v1';
    current.config.tasks.chat.inputMicrosPerMillion = 2_000_000;
    current.config.tasks.chat.outputMicrosPerMillion = 10_000_000;
    amend?.(current.config);
    return (
      await agent
        .put('/api/models/config')
        .send({
          requestId: randomUUID(),
          expectedVersion: current.version,
          config: current.config,
          evaluationNote: '本地供应商协议评估，不写成长。',
        })
        .expect(200)
    ).body.data;
  }

  it('默认配置独立记录各任务，更新保留历史、拒绝过期版本，重启后仍生效', async () => {
    await request(app.getHttpServer()).get('/api/models/config').expect(401);
    let agent = await login();
    const original = (await agent.get('/api/models/config').expect(200)).body.data;
    expect(original).toMatchObject({
      version: 1,
      source: 'default',
      config: { currency: 'USD', window: 'utc_day' },
    });
    expect(original.config.tasks.chat.providerId).toBe('test');
    expect(original.config.tasks.embedding.model).toBe('test-embedding-v1');
    const changed = structuredClone(original.config);
    changed.tasks.chat.maxOutputTokens = 256;
    const command = {
      requestId: randomUUID(),
      expectedVersion: 1,
      config: changed,
      evaluationNote: '本地协议验证，无业务成长写入。',
    };
    const saved = (await agent.put('/api/models/config').send(command).expect(200)).body.data;
    expect(saved).toMatchObject({ version: 2, source: 'deployment', config: changed });
    await agent
      .put('/api/models/config')
      .send(command)
      .expect(200)
      .expect((r) => expect(r.body.data).toEqual(saved));
    await agent
      .put('/api/models/config')
      .send({ ...command, requestId: randomUUID() })
      .expect(409);
    await agent
      .get('/api/models/config/versions/1')
      .expect(200)
      .expect((r) => expect(r.body.data).toEqual(original));
    await app.close();
    app = await createApplication(config);
    agent = await login();
    await agent
      .get('/api/models/config')
      .expect(200)
      .expect((r) => expect(r.body.data).toEqual(saved));
  });

  it('确定性模型可生成校验后的结果，同键重放不重复计费，调用记录与额度可回查', async () => {
    const agent = await login();
    const command = {
      requestId: randomUUID(),
      expectedConfigVersion: 1,
      role: 'chat',
      operation: 'structured',
      inputText: '你好',
    };
    const response = await agent.post('/api/models/probes').send(command).expect(201);
    const call = response.body.data;
    expect(call).toMatchObject({
      status: 'succeeded',
      role: 'chat',
      providerId: 'test',
      configVersion: 1,
      result: { kind: 'structured', value: { ok: true, reply: '测试模型已收到：你好' } },
    });
    expect(call.attempts).toHaveLength(1);
    expect(call.attempts[0]).toMatchObject({
      status: 'succeeded',
      usageSource: 'reported',
      inputTokens: 12,
      outputTokens: 8,
      chargedTokens: 20,
      chargedCostMicros: 0,
    });
    await agent
      .post('/api/models/probes')
      .send(command)
      .expect(201)
      .expect((r) => expect(r.body.data).toEqual(call));
    await agent
      .post('/api/models/probes')
      .send({ ...command, inputText: '改变输入' })
      .expect(409);
    await agent
      .get(`/api/models/calls/${call.id}`)
      .expect(200)
      .expect((r) => expect(r.body.data).toEqual(call));
    const usage = (await agent.get('/api/models/usage').expect(200)).body.data;
    expect(usage.global.charged).toEqual({ requests: 1, tokens: 20, costMicros: 0 });
    expect(usage.tasks.chat.charged).toEqual({ requests: 1, tokens: 20, costMicros: 0 });
    expect(usage.tasks.memory.charged.requests).toBe(0);
  });

  it('并发请求不能共同超支，降额和重启仍保留已经消耗的额度', async () => {
    let agent = await login();
    const original = (await agent.get('/api/models/config')).body.data;
    original.config.dailyBudget.requests = 1;
    await agent
      .put('/api/models/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: 1,
        config: original.config,
        evaluationNote: '并发额度验证。',
      })
      .expect(200);
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        agent.post('/api/models/probes').send({
          requestId: randomUUID(),
          expectedConfigVersion: 2,
          role: 'chat',
          operation: 'text',
          inputText: '并发测试',
        }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 429, 429, 429]);
    for (const failed of responses.filter((r) => r.status === 429))
      expect(failed.body.code).toBe(42901);
    original.config.dailyBudget.requests = 0;
    await agent
      .put('/api/models/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: 2,
        config: original.config,
        evaluationNote: '暂停，不清额度。',
      })
      .expect(200);
    await app.close();
    app = await createApplication(config);
    agent = await login();
    const usage = (await agent.get('/api/models/usage').expect(200)).body.data;
    expect(usage.global.limit.requests).toBe(0);
    expect(usage.global.charged.requests).toBe(1);
    await agent
      .post('/api/models/probes')
      .send({
        requestId: randomUUID(),
        expectedConfigVersion: 3,
        role: 'chat',
        operation: 'text',
        inputText: '已暂停',
      })
      .expect(429);
  });

  it('真实 HTTP adapter 发送固定模型与严格 JSON schema，按上报用量和配置价格结算且不暴露密钥', async () => {
    let received: unknown;
    let authorization: string | undefined;
    const agent = await connectProvider((req, res) => {
      authorization = req.headers.authorization;
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        received = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            id: 'fixture-response',
            model: 'fixed-model-v1',
            choices: [
              { finish_reason: 'stop', message: { content: '{"ok":true,"reply":"协议可用"}' } },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          }),
        );
      });
    });
    const current = await useProvider(agent);
    const response = await agent
      .post('/api/models/probes')
      .send({
        requestId: randomUUID(),
        expectedConfigVersion: current.version,
        role: 'chat',
        operation: 'structured',
        inputText: '独立协议验证',
      })
      .expect(201);
    expect(authorization).toBe('Bearer private-fixture-key');
    expect(received).toMatchObject({
      model: 'fixed-model-v1',
      max_completion_tokens: 512,
      stream: false,
      response_format: { type: 'json_schema', json_schema: { strict: true } },
    });
    expect(response.body.data).toMatchObject({
      status: 'succeeded',
      result: { kind: 'structured', value: { ok: true, reply: '协议可用' } },
    });
    expect(response.body.data.attempts[0]).toMatchObject({
      usageSource: 'reported',
      inputTokens: 100,
      outputTokens: 20,
      chargedCostMicros: 400,
      chargedTokens: 120,
    });
    const catalog = await agent.get('/api/models/providers').expect(200);
    expect(catalog.body.data.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'fixture', credentialConfigured: true }),
      ]),
    );
    expect(JSON.stringify([response.body, catalog.body, current])).not.toContain(
      'private-fixture-key',
    );
  });

  it('明确的暂时错误有限重试，每次尝试分别占用请求及未知用量额度', async () => {
    let requests = 0;
    const agent = await connectProvider((_req, res) => {
      requests += 1;
      res.setHeader('content-type', 'application/json');
      if (requests === 1) {
        res.statusCode = 503;
        res.end('{"error":"private-fixture-key"}');
        return;
      }
      res.end(
        JSON.stringify({
          model: 'fixed-model-v1',
          choices: [{ finish_reason: 'stop', message: { content: '重试完成' } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      );
    });
    const current = await useProvider(agent, (config) => {
      config.tasks.chat.maxAttempts = 2;
    });
    const response = await agent
      .post('/api/models/probes')
      .send({
        requestId: randomUUID(),
        expectedConfigVersion: current.version,
        role: 'chat',
        operation: 'text',
        inputText: 'hi',
      })
      .expect(201);
    expect(response.body.data.status).toBe('succeeded');
    expect(response.body.data.attempts).toEqual([
      expect.objectContaining({
        number: 1,
        status: 'failed',
        errorCode: 50202,
        usageSource: 'reserved',
        chargedTokens: 1026,
        chargedCostMicros: 6148,
      }),
      expect.objectContaining({
        number: 2,
        status: 'succeeded',
        usageSource: 'reported',
        chargedTokens: 120,
        chargedCostMicros: 400,
      }),
    ]);
    const usage = (await agent.get('/api/models/usage')).body.data;
    expect(usage.global.charged).toEqual({ requests: 2, tokens: 1146, costMicros: 6548 });
    expect(requests).toBe(2);
    expect(JSON.stringify(response.body)).not.toContain('private-fixture-key');
  });

  it('取消已发送请求后保留预留，同键重放与重启不会再次向供应商发送', async () => {
    let sent!: () => void;
    const sending = new Promise<void>((resolve) => {
      sent = resolve;
    });
    let requests = 0;
    const agent = await connectProvider((_req, _res) => {
      requests += 1;
      sent();
    });
    const current = await useProvider(agent);
    const command = {
      requestId: randomUUID(),
      expectedConfigVersion: current.version,
      role: 'chat',
      operation: 'text',
      inputText: 'hi',
    };
    const pending = agent
      .post('/api/models/probes')
      .send(command)
      .then((response) => response);
    await sending;
    const running = (await agent.post('/api/models/probes').send(command).expect(201)).body.data;
    expect(running.status).toBe('running');
    const cancelled = await agent.post(`/api/models/calls/${running.id}/cancel`).expect(200);
    expect(cancelled.body.data.status).toBe('cancelled');
    const finished = (await pending).body.data;
    expect(finished).toMatchObject({ status: 'cancelled', result: null, errorCode: 40909 });
    expect(finished.attempts[0]).toMatchObject({ usageSource: 'reserved', chargedTokens: 1026 });
    await app.close();
    app = await createApplication(config);
    const restarted = await login();
    await restarted
      .post('/api/models/probes')
      .send(command)
      .expect(201)
      .expect((response) => expect(response.body.data.status).toBe('cancelled'));
    expect(requests).toBe(1);
    expect((await restarted.get('/api/models/usage')).body.data.global.charged.requests).toBe(1);
  });

  it('业务模块可提供独立提示词和输出规范，统一调用只返回候选而不修改伴侣', async () => {
    let received: unknown;
    const agent = await connectProvider((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        received = JSON.parse(body);
        res.end(
          JSON.stringify({
            model: 'fixed-model-v1',
            choices: [{ finish_reason: 'stop', message: { content: '{"traits":["好奇"]}' } }],
            usage: { prompt_tokens: 30, completion_tokens: 10 },
          }),
        );
      });
    });
    const current = await useProvider(agent, (config) => {
      config.tasks.persona = {
        ...config.tasks.chat,
        promptVersion: 'persona-fixture-v1',
        schemaVersion: 'traits-v1',
      };
    });
    const companion = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: '候选验证', initialProfile: '保留初始人生。' })
        .expect(201)
    ).body.data;
    const output = await app.get(ModelRuntimeService).execute(
      {
        requestId: randomUUID(),
        expectedConfigVersion: current.version,
        role: 'persona',
        operation: 'structured',
        inputText: '解析初始设定',
        lane: 'background',
      },
      {
        promptVersion: 'persona-fixture-v1',
        schemaVersion: 'traits-v1',
        preprocessingVersion: 'utf8-v1',
        systemPrompt: '将人设解析为 traits 字符串数组。',
        outputSchema: z.object({ traits: z.array(z.string()).min(1) }).strict(),
      },
      { companionId: companion.id, runtimeEpoch: 1, conversationId: null },
    );
    expect(output).toMatchObject({
      status: 'succeeded',
      result: { kind: 'structured', value: { traits: ['好奇'] } },
      context: {
        kind: 'task',
        companionId: companion.id,
        promptVersion: 'persona-fixture-v1',
        schemaVersion: 'traits-v1',
      },
    });
    expect(received).toMatchObject({
      messages: [
        { role: 'system', content: '将人设解析为 traits 字符串数组。' },
        { role: 'user', content: '解析初始设定' },
      ],
      response_format: { json_schema: { schema: { properties: { traits: { type: 'array' } } } } },
    });
    await agent
      .get(`/api/companions/${companion.id}`)
      .expect(200)
      .expect((response) => expect(response.body.data).toEqual(companion));
  });

  it('响应正文中途超时保持未知状态与预留，最多尝试次数不会导致自动重发', async () => {
    let count = 0;
    const agent = await connectProvider((_req, res) => {
      count += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"choices":');
    });
    const current = await useProvider(agent, (config) => {
      config.tasks.chat.timeoutMs = 100;
      config.tasks.chat.maxAttempts = 3;
    });
    const command = {
      requestId: randomUUID(),
      expectedConfigVersion: current.version,
      role: 'chat',
      operation: 'text',
      inputText: 'hi',
    };
    const response = (await agent.post('/api/models/probes').send(command).expect(201)).body.data;
    expect(response).toMatchObject({ status: 'unknown', result: null, errorCode: 50203 });
    expect(response.attempts[0]).toMatchObject({ usageSource: 'reserved', chargedTokens: 1026 });
    await agent
      .post('/api/models/probes')
      .send(command)
      .expect(201)
      .expect((r) => expect(r.body.data).toEqual(response));
    expect(count).toBe(1);
  });

  it.each(['malformed', 'wrong_fields', 'extra_fields', 'truncated', 'refused'])(
    '结构化输出 %s 不生成可用结果，已发生的用量仍结算',
    async (scenario) => {
      let requests = 0;
      const agent = await connectProvider((_req, res) => {
        requests += 1;
        const content =
          scenario === 'malformed'
            ? 'not-json-private-input'
            : scenario === 'wrong_fields'
              ? '{"ok":"yes","reply":"错误"}'
              : scenario === 'extra_fields'
                ? '{"ok":true,"reply":"内容","extra":"不能静默丢弃"}'
                : '{"ok":true,"reply":"内容"}';
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: scenario === 'truncated' ? 'length' : 'stop',
                message: { content, refusal: scenario === 'refused' ? '拒绝' : null },
              },
            ],
            usage: { prompt_tokens: 30, completion_tokens: 10 },
          }),
        );
      });
      const current = await useProvider(agent, (config) => {
        config.tasks.chat.maxAttempts = 3;
      });
      const response = (
        await agent
          .post('/api/models/probes')
          .send({
            requestId: randomUUID(),
            expectedConfigVersion: current.version,
            role: 'chat',
            operation: 'structured',
            inputText: '输出校验',
          })
          .expect(201)
      ).body.data;
      expect(response).toMatchObject({ status: 'failed', errorCode: 50201, result: null });
      expect(response.attempts[0]).toMatchObject({
        usageSource: 'reported',
        chargedTokens: 40,
        chargedCostMicros: 160,
      });
      expect(requests).toBe(1);
      expect(JSON.stringify(response)).not.toContain('not-json-private-input');
    },
  );

  it('embedding 使用独立模型及维度，拒绝错误维度后仍可正常编码', async () => {
    let received: unknown;
    let correct = false;
    const agent = await connectProvider((req, res) => {
      expect(req.url).toBe('/v1/embeddings');
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        received = JSON.parse(body);
        res.end(
          JSON.stringify({
            model: 'embedding-fixture-v1',
            data: [{ index: 0, embedding: correct ? [1, 0, 0, 0] : [1, 0, 0] }],
            usage: { prompt_tokens: 7, total_tokens: 7 },
          }),
        );
      });
    });
    const current = await useProvider(agent, (config) => {
      config.tasks.embedding.providerId = 'fixture';
      config.tasks.embedding.model = 'embedding-fixture-v1';
      config.tasks.embedding.inputMicrosPerMillion = 0;
      config.tasks.embedding.outputMicrosPerMillion = 0;
    });
    const command = {
      expectedConfigVersion: current.version,
      role: 'embedding',
      operation: 'embedding',
      inputText: '向量测试',
    };
    const failed = (
      await agent
        .post('/api/models/probes')
        .send({ ...command, requestId: randomUUID() })
        .expect(201)
    ).body.data;
    expect(failed).toMatchObject({ status: 'failed', result: null, errorCode: 50201 });
    correct = true;
    const passed = (
      await agent
        .post('/api/models/probes')
        .send({ ...command, requestId: randomUUID() })
        .expect(201)
    ).body.data;
    expect(passed.result).toEqual({ kind: 'embedding', vector: [1, 0, 0, 0] });
    expect(passed.attempts[0]).toMatchObject({ inputTokens: 7, outputTokens: 0 });
    expect(received).toEqual({
      model: 'embedding-fixture-v1',
      input: '向量测试',
      encoding_format: 'float',
      dimensions: 4,
    });
    expect((await agent.get('/api/models/usage')).body.data.tasks.embedding.charged).toEqual({
      requests: 2,
      tokens: 14,
      costMicros: 0,
    });
  });

  it('任务额度不足以重试时不再次请求，也不会只扣全局额度', async () => {
    let count = 0;
    const agent = await connectProvider((_req, res) => {
      count += 1;
      res.statusCode = 503;
      res.end('{}');
    });
    const current = await useProvider(agent, (config) => {
      config.tasks.chat.maxAttempts = 3;
      config.tasks.chat.dailyBudget.requests = 1;
    });
    const response = (
      await agent
        .post('/api/models/probes')
        .send({
          requestId: randomUUID(),
          expectedConfigVersion: current.version,
          role: 'chat',
          operation: 'text',
          inputText: 'hi',
        })
        .expect(201)
    ).body.data;
    expect(response).toMatchObject({ status: 'failed', errorCode: 42901 });
    expect(response.attempts).toHaveLength(1);
    expect(count).toBe(1);
    const usage = (await agent.get('/api/models/usage')).body.data;
    expect(usage.global.charged).toEqual({ requests: 1, tokens: 1026, costMicros: 6148 });
    expect(usage.tasks.chat.charged).toEqual({ requests: 1, tokens: 1026, costMicros: 6148 });
  });

  it.each(['tokens', 'costMicros'] as const)(
    '%s 额度不足时在访问供应商之前拒绝，已有配置修改不能绕过部署上限',
    async (field) => {
      let count = 0;
      const agent = await connectProvider((_req, res) => {
        count += 1;
        res.end('{}');
      });
      const current = await useProvider(agent, (config) => {
        config.dailyBudget[field] = 1;
      });
      await agent
        .post('/api/models/probes')
        .send({
          requestId: randomUUID(),
          expectedConfigVersion: current.version,
          role: 'chat',
          operation: 'text',
          inputText: 'hi',
        })
        .expect(429)
        .expect((r) => expect(r.body.code).toBe(42901));
      expect(count).toBe(0);
      expect((await agent.get('/api/models/usage')).body.data.global.charged.requests).toBe(0);
      const invalid = structuredClone(current.config);
      invalid.maxConcurrent = 16;
      await agent
        .put('/api/models/config')
        .send({
          requestId: randomUUID(),
          expectedVersion: current.version,
          config: invalid,
          evaluationNote: '不能突破部署上限。',
        })
        .expect(400);
      await agent
        .get('/api/models/config')
        .expect(200)
        .expect((r) => expect(r.body.data).toEqual(current));
    },
  );

  it('请求发出后进程被终止，重启按持久期限标记未知且不释放额度或重复发送', async () => {
    let sent!: () => void;
    const sending = new Promise<void>((resolve) => {
      sent = resolve;
    });
    let count = 0;
    const agent = await connectProvider((_req, _res) => {
      count += 1;
      sent();
    });
    const current = await useProvider(agent, (config) => {
      config.tasks.chat.timeoutMs = 1000;
    });
    const definition = config.modelDeployment!.providers[0]!;
    worker = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./support/model-process.ts', import.meta.url))],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DATABASE_URL: config.databaseUrl,
          ADMIN_PASSWORD: config.adminPassword,
          QDRANT_URL: config.qdrantUrl,
          QDRANT_API_KEY: config.qdrantApiKey,
          DATA_DIR: dataDir,
          MODEL_PROVIDERS_JSON: JSON.stringify([
            {
              id: 'fixture',
              baseUrl: definition.baseUrl,
              apiKeyEnv: 'MODEL_FIXTURE_KEY',
              capabilities: ['text', 'structured', 'embedding'],
            },
          ]),
          MODEL_FIXTURE_KEY: 'private-fixture-key',
        },
      },
    );
    const workerUrl = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('测试子进程启动超时。')), 5000);
      worker!.once('error', () => {
        clearTimeout(timer);
        reject(new Error('测试子进程无法启动。'));
      });
      worker!.stdout!.on('data', (chunk) => {
        output += String(chunk);
        if (output.includes('\n')) {
          clearTimeout(timer);
          resolve((JSON.parse(output.split('\n')[0]!) as { url: string }).url);
        }
      });
    });
    const remote = request.agent(workerUrl);
    await remote.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    const command = {
      requestId: randomUUID(),
      expectedConfigVersion: current.version,
      role: 'chat',
      operation: 'text',
      inputText: 'hi',
    };
    const pending = remote
      .post('/api/models/probes')
      .send(command)
      .then(
        () => undefined,
        () => undefined,
      );
    await sending;
    const exited = once(worker, 'exit');
    worker.kill('SIGKILL');
    await exited;
    await pending;
    let call = (await agent.post('/api/models/probes').send(command).expect(201)).body.data;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(call.attempts[0].deadlineAt) - Date.now()) + 30),
    );
    call = (await agent.get(`/api/models/calls/${call.id}`).expect(200)).body.data;
    expect(call).toMatchObject({ status: 'unknown', result: null, errorCode: 50203 });
    expect(call.attempts[0]).toMatchObject({
      status: 'unknown',
      usageSource: 'reserved',
      chargedTokens: 1026,
    });
    await agent
      .post('/api/models/probes')
      .send(command)
      .expect(201)
      .expect((r) => expect(r.body.data).toEqual(call));
    expect(count).toBe(1);
    expect((await agent.get('/api/models/usage')).body.data.global.charged).toEqual({
      requests: 1,
      tokens: 1026,
      costMicros: 6148,
    });
  });

  it('后台占满自身并发时仍保留交互容量，总容量占满后阻止额外请求', async () => {
    const replies: ServerResponse[] = [];
    let firstSent!: () => void;
    let secondSent!: () => void;
    const first = new Promise<void>((resolve) => {
      firstSent = resolve;
    });
    const second = new Promise<void>((resolve) => {
      secondSent = resolve;
    });
    const agent = await connectProvider((_req, res) => {
      replies.push(res);
      if (replies.length === 1) firstSent();
      else secondSent();
    });
    const current = await useProvider(agent);
    const command = {
      expectedConfigVersion: current.version,
      role: 'chat',
      operation: 'text',
      inputText: '并发分配',
    };
    const background = agent
      .post('/api/models/probes')
      .send({ ...command, requestId: randomUUID(), lane: 'background' })
      .then((r) => r);
    await first;
    await agent
      .post('/api/models/probes')
      .send({ ...command, requestId: randomUUID(), lane: 'background' })
      .expect(429)
      .expect((r) => expect(r.body.code).toBe(42902));
    const interactive = agent
      .post('/api/models/probes')
      .send({ ...command, requestId: randomUUID(), lane: 'interactive' })
      .then((r) => r);
    await second;
    await agent
      .post('/api/models/probes')
      .send({ ...command, requestId: randomUUID() })
      .expect(429)
      .expect((r) => expect(r.body.code).toBe(42902));
    expect((await agent.get('/api/models/usage')).body.data.activeRequests).toBe(2);
    for (const res of replies)
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: '完成' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    expect((await background).body.data.status).toBe('succeeded');
    expect((await interactive).body.data.status).toBe('succeeded');
    expect((await agent.get('/api/models/usage')).body.data.activeRequests).toBe(0);
  });

  it('输出完整但缺少用量时可返回候选，费用与 token 不会被当作零消耗', async () => {
    const agent = await connectProvider((_req, res) => {
      res.end(
        JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '输出完整' } }] }),
      );
    });
    const current = await useProvider(agent);
    const response = (
      await agent
        .post('/api/models/probes')
        .send({
          requestId: randomUUID(),
          expectedConfigVersion: current.version,
          role: 'chat',
          operation: 'text',
          inputText: 'hi',
        })
        .expect(201)
    ).body.data;
    expect(response).toMatchObject({
      status: 'succeeded',
      result: { kind: 'text', text: '输出完整' },
    });
    expect(response.attempts[0]).toMatchObject({
      usageSource: 'reserved',
      inputTokens: null,
      outputTokens: null,
      chargedTokens: 1026,
      chargedCostMicros: 6148,
    });
    expect((await agent.get('/api/models/usage')).body.data.global.charged).toEqual({
      requests: 1,
      tokens: 1026,
      costMicros: 6148,
    });
  });

  it('首次请求失败期间切换配置，旧调用不能静默使用新模型或继续旧配置重试', async () => {
    let sent!: () => void;
    const sending = new Promise<void>((resolve) => {
      sent = resolve;
    });
    let reply!: ServerResponse;
    let count = 0;
    const agent = await connectProvider((_req, res) => {
      count += 1;
      reply = res;
      sent();
    });
    const current = await useProvider(agent, (config) => {
      config.tasks.chat.maxAttempts = 3;
    });
    const pending = agent
      .post('/api/models/probes')
      .send({
        requestId: randomUUID(),
        expectedConfigVersion: current.version,
        role: 'chat',
        operation: 'text',
        inputText: 'hi',
      })
      .then((r) => r);
    await sending;
    current.config.tasks.chat.enabled = false;
    await agent
      .put('/api/models/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: current.version,
        config: current.config,
        evaluationNote: '停用后阻止新派发。',
      })
      .expect(200);
    reply.statusCode = 503;
    reply.end('{}');
    const response = (await pending).body.data;
    expect(response).toMatchObject({
      status: 'failed',
      errorCode: 40902,
      configVersion: current.version,
    });
    expect(response.attempts).toHaveLength(1);
    expect(count).toBe(1);
    expect((await agent.get('/api/models/usage')).body.data.global.charged.requests).toBe(1);
  });
});
