import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../src/app';
import type { ServerConfig } from '../src/config';
import { TaskWorkerService } from '../src/modules/tasks/task-worker.service';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';
import { createTestAuthConfig, disposeTestAuth } from './support/redis';

afterAll(disposeTestAuth);

describe('F12 终端公开协议', () => {
  let app: INestApplication;
  let config: ServerConfig;
  let database: TestDatabase;
  let directory: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    directory = await mkdtemp(join(tmpdir(), 'memory-weave-terminals-'));
    config = {
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      qdrantUrl: 'http://127.0.0.1:1',
      qdrantApiKey: 'isolated-vector-key',
      ...createTestAuthConfig(),
      adminPassword: 'terminals-test-password',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir: directory,
      webDistDir: null,
      terminalConfiguration: { heartbeatTimeoutMs: 1_200, actionTimeoutMs: 12_000 },
    };
    app = await createApplication(config);
  }, 30_000);
  afterEach(async () => {
    await app?.close();
    await database?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30_000);

  async function login() {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    return agent;
  }

  async function makeScope(agent: Awaited<ReturnType<typeof login>>, name: string) {
    const companion = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name, initialProfile: '按真实动作结果判断。' })
        .expect(201)
    ).body.data;
    const chat = (
      await agent
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          companionId: companion.id,
          runtimeEpoch: 1,
          title: name,
        })
        .expect(201)
    ).body.data;
    return { companionId: String(companion.id), conversationId: String(chat.id), runtimeEpoch: 1 };
  }

  function device() {
    const id = randomUUID();
    const secret = randomBytes(32).toString('hex');
    const base = `/api/terminals/${id}`;
    return {
      id,
      secret,
      base,
      send: (path: string, body: object) =>
        request(app.getHttpServer())
          .post(`${base}/${path}`)
          .set('authorization', `Bearer ${secret}`)
          .send(body),
      receipt: (actionId: string, body: object) =>
        request(app.getHttpServer())
          .put(`${base}/actions/${actionId}/receipt`)
          .set('authorization', `Bearer ${secret}`)
          .send(body),
    };
  }

  it('隔离账号与设备权限，使用一次领取和重启后的确切回执确认旧派发', async () => {
    let owner = await login();
    const target = device();
    const other = device();
    const input = { name: '测试端', secret: target.secret };
    await request(app.getHttpServer()).put(target.base).send(input).expect(401);
    const registered = await owner.put(target.base).send(input).expect(200);
    expect(registered.body.data).toMatchObject({
      id: target.id,
      state: 'offline',
      capabilities: [],
    });
    expect(JSON.stringify(registered.body)).not.toContain(target.secret);
    await owner.put(target.base).send(input).expect(200);
    await owner
      .put(target.base)
      .send({ ...input, name: '不同设备' })
      .expect(409);
    await owner.put(other.base).send({ name: '另一终端', secret: other.secret }).expect(200);
    await request(app.getHttpServer())
      .post(`${target.base}/connect`)
      .set('authorization', `Bearer ${other.secret}`)
      .send({ workspaceId: 'test', capabilities: ['diagnostic.echo'] })
      .expect(401);
    await owner
      .post(`${target.base}/connect`)
      .send({ workspaceId: 'test', capabilities: ['diagnostic.echo'] })
      .expect(401);

    const scope = await makeScope(owner, '阿澜');
    const grant = { ...scope, workspaceId: 'test', tool: 'diagnostic.echo' };
    const command = {
      ...grant,
      requestId: randomUUID(),
      terminalId: target.id,
      arguments: { text: '一次执行' },
    };
    await owner.post('/api/terminals/actions').send(command).expect(403);
    await owner
      .put(`${target.base}/grants`)
      .send({ ...grant, expectedVersion: 0, enabled: true })
      .expect(200);
    const queued = (await owner.post('/api/terminals/actions').send(command).expect(201)).body.data;
    expect(queued.state).toBe('queued');
    expect(
      (await owner.post('/api/terminals/actions').send(command).expect(201)).body.data.id,
    ).toBe(queued.id);
    await owner
      .post('/api/terminals/actions')
      .send({ ...command, arguments: { text: '不同内容' } })
      .expect(409);

    const connected = (
      await target
        .send('connect', { workspaceId: 'test', capabilities: ['diagnostic.echo'] })
        .expect(200)
    ).body.data;
    const claims = await Promise.all([
      target.send('claim', { connectionId: connected.connectionId }),
      target.send('claim', { connectionId: connected.connectionId }),
    ]);
    expect(claims.map(({ status }) => status)).toEqual([200, 200]);
    const [dispatch] = claims.flatMap(({ body }) => (body.data ? [body.data] : []));
    expect(claims.filter(({ body }) => body.data)).toHaveLength(1);
    expect(dispatch).toMatchObject({ id: queued.id, arguments: command.arguments });
    expect(
      (await owner.get(`/api/terminals/actions/${queued.id}`).expect(200)).body.data.state,
    ).toBe('dispatched');
    await app.close();
    app = await createApplication(config);
    owner = await login();

    const resumed = (
      await target.send('connect', { workspaceId: 'new-workspace', capabilities: [] }).expect(200)
    ).body.data;
    await target.send('heartbeat', { connectionId: connected.connectionId }).expect(409);
    expect(
      (await owner.get(`/api/terminals/actions/${queued.id}`).expect(200)).body.data.state,
    ).toBe('unknown');
    expect(
      (await target.send('claim', { connectionId: resumed.connectionId }).expect(200)).body.data,
    ).toBeNull();
    const receipt = {
      connectionId: resumed.connectionId,
      claimId: dispatch.claimId,
      outcome: { state: 'succeeded', result: { text: '一次执行' } },
    };
    await target.receipt(queued.id, { ...receipt, claimId: randomUUID() }).expect(404);
    await target
      .receipt(queued.id, {
        ...receipt,
        outcome: { state: 'succeeded', result: { text: '其他结果' } },
      })
      .expect(400);
    for (let index = 0; index < 2; index++)
      expect((await target.receipt(queued.id, receipt).expect(200)).body.data).toMatchObject({
        id: queued.id,
        state: 'succeeded',
        result: { text: '一次执行' },
      });
    await target.receipt(queued.id, { ...receipt, outcome: { state: 'failed' } }).expect(409);
  }, 25_000);

  it('按当前工作区和伴侣授权形成快照，心跳超时立即失去执行能力', async () => {
    await app.close();
    config.terminalConfiguration = { heartbeatTimeoutMs: 3_000, actionTimeoutMs: 18_000 };
    app = await createApplication(config);
    const owner = await login();
    const target = device();
    const scope = await makeScope(owner, '阿溪');
    const foreign = await makeScope(owner, '星晚');
    const grant = { ...scope, workspaceId: 'local', tool: 'diagnostic.echo' };
    await owner.put(target.base).send({ name: '测试端', secret: target.secret }).expect(200);
    await owner
      .put(`${target.base}/grants`)
      .send({ ...grant, expectedVersion: 0, enabled: true })
      .expect(200);
    await owner
      .post('/api/terminals/actions')
      .send({
        ...grant,
        ...foreign,
        requestId: randomUUID(),
        terminalId: target.id,
        arguments: { text: '无授权' },
      })
      .expect(403);
    const connected = (
      await target
        .send('connect', { workspaceId: 'local', capabilities: ['diagnostic.echo'] })
        .expect(200)
    ).body.data;
    const path = `/api/chats/${scope.conversationId}`;
    await owner
      .post(`${path}/messages`)
      .send({ requestId: randomUUID(), text: '看看此轮的设备能力。' })
      .expect(201);
    await app.get(TaskWorkerService).start();
    let current;
    for (let i = 0; i < 60; i++) {
      const state = (await owner.get(path).expect(200)).body.data;
      current = state.currentRun;
      if (current?.context) break;
      await target.send('heartbeat', { connectionId: connected.connectionId }).expect(200);
      await delay(65);
    }
    expect(current.context.terminalCapabilities).toEqual([
      { terminalId: target.id, workspaceId: 'local', tool: 'diagnostic.echo' },
    ]);
    const queued = (
      await owner
        .post('/api/terminals/actions')
        .send({
          ...grant,
          requestId: randomUUID(),
          terminalId: target.id,
          arguments: { text: '只取消未派发' },
        })
        .expect(201)
    ).body.data;
    const mismatch = (
      await target
        .send('connect', { workspaceId: 'other', capabilities: ['diagnostic.echo'] })
        .expect(200)
    ).body.data;
    expect(
      (await target.send('claim', { connectionId: mismatch.connectionId }).expect(200)).body.data,
    ).toBeNull();
    expect(
      (await owner.post(`/api/terminals/actions/${queued.id}/cancel`).expect(200)).body.data.state,
    ).toBe('cancelled');
    await delay(3_100);
    await target.send('claim', { connectionId: mismatch.connectionId }).expect(409);
    const inventory = await owner.get('/api/terminals').expect(200);
    expect(inventory.body.data.items).toEqual([
      expect.objectContaining({ state: 'offline', capabilities: [] }),
    ]);
    await owner.post(`${target.base}/revoke`).expect(200);
    await target
      .send('connect', { workspaceId: 'local', capabilities: ['diagnostic.echo'] })
      .expect(401);
  }, 25_000);

  it('授权换版与来源删除会使已排队动作失效', async () => {
    const owner = await login();
    const target = device();
    const scope = await makeScope(owner, '星见');
    const access = { ...scope, workspaceId: 'local', tool: 'diagnostic.echo' };
    await owner.put(target.base).send({ name: '测试端', secret: target.secret }).expect(200);
    await owner
      .put(`${target.base}/grants`)
      .send({ ...access, expectedVersion: 0, enabled: true })
      .expect(200);
    const conversation = `/api/conversations/${scope.conversationId}`;
    const message = (
      await owner
        .post(`/api/chats/${scope.conversationId}/messages`)
        .send({ requestId: randomUUID(), text: '诊断的确切来源。' })
        .expect(201)
    ).body.data.message;
    const source = { messageId: message.id, contentVersion: message.contentVersion };
    const command = {
      ...access,
      requestId: randomUUID(),
      terminalId: target.id,
      source,
      arguments: { text: '删除后不能派发' },
    };
    const queued = (await owner.post('/api/terminals/actions').send(command).expect(201)).body.data;
    await owner
      .put(`${target.base}/grants`)
      .send({ ...access, expectedVersion: 1, enabled: false })
      .expect(200);
    await owner
      .put(`${target.base}/grants`)
      .send({ ...access, expectedVersion: 2, enabled: true })
      .expect(200);
    expect(
      (await owner.get(`/api/terminals/actions/${queued.id}`).expect(200)).body.data.state,
    ).toBe('invalidated');
    const second = (
      await owner
        .post('/api/terminals/actions')
        .send({ ...command, requestId: randomUUID() })
        .expect(201)
    ).body.data;
    const current = (await owner.get(conversation).expect(200)).body.data.conversation;
    const operation = (
      await owner
        .post('/api/lifecycle')
        .send({
          requestId: randomUUID(),
          kind: 'delete_messages',
          conversationId: scope.conversationId,
          expectedVersion: current.version,
          messages: [source],
        })
        .expect(201)
    ).body.data;
    const connection = (
      await target
        .send('connect', { workspaceId: 'local', capabilities: ['diagnostic.echo'] })
        .expect(200)
    ).body.data;
    expect(
      (await target.send('claim', { connectionId: connection.connectionId }).expect(200)).body.data,
    ).toBeNull();
    await app.get(TaskWorkerService).start();
    let completed;
    for (let i = 0; i < 150; i++) {
      completed = (await owner.get(`/api/lifecycle/${operation.id}`).expect(200)).body.data;
      if (completed.completedAt) break;
      await delay(55);
    }
    expect(completed.completedAt).toEqual(expect.any(String));
    await owner.get(`/api/terminals/actions/${second.id}`).expect(404);
  }, 25_000);
  it('独立测试终端通过 HTTP 提交真实回执', async () => {
    await app.listen(0, '127.0.0.1');
    const owner = await login();
    const target = device();
    const scope = await makeScope(owner, '桐木');
    const grant = { ...scope, workspaceId: 'local', tool: 'diagnostic.echo' };
    await owner.put(target.base).send({ name: '进程测试端', secret: target.secret }).expect(200);
    await owner
      .put(`${target.base}/grants`)
      .send({ ...grant, expectedVersion: 0, enabled: true })
      .expect(200);
    const action = (
      await owner
        .post('/api/terminals/actions')
        .send({
          ...grant,
          requestId: randomUUID(),
          terminalId: target.id,
          arguments: { text: '来自独立终端' },
        })
        .expect(201)
    ).body.data;
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../../../scripts/test-terminal.mjs', import.meta.url))],
      {
        env: {
          ...process.env,
          TEST_TERMINAL_URL: await app.getUrl(),
          TEST_TERMINAL_ID: target.id,
          TEST_TERMINAL_SECRET: target.secret,
          TEST_TERMINAL_JOURNAL: join(directory, 'receipts'),
        },
        stdio: 'ignore',
      },
    );
    const exited = once(child, 'exit');
    try {
      let result;
      for (let i = 0; i < 100; i++) {
        result = (await owner.get(`/api/terminals/actions/${action.id}`).expect(200)).body.data;
        if (result.state === 'succeeded' || child.exitCode !== null) break;
        await delay(65);
      }
      expect(result).toMatchObject({
        state: 'succeeded',
        origin: 'web',
        terminalId: target.id,
        result: { text: '来自独立终端' },
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
    }
  }, 25_000);
});
