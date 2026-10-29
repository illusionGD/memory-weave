import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../src/app';
import type { ServerConfig } from '../src/config';
import { loadServerConfig } from '../src/config';
import { TaskWorkerService } from '../src/modules/tasks/task-worker.service';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';

describe('生命周期公共命令与恢复', () => {
  let app: INestApplication;
  let database: TestDatabase;
  let dataDir: string;
  let config: ServerConfig;
  let provider: Server | undefined;
  let worker: ChildProcess | undefined;
  beforeEach(async () => {
    database = await createTestDatabase();
    dataDir = await mkdtemp(join(tmpdir(), 'memory-weave-lifecycle-'));
    config = {
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      qdrantUrl: process.env.TEST_QDRANT_URL ?? 'http://127.0.0.1:1',
      qdrantApiKey: process.env.TEST_QDRANT_API_KEY ?? 'test-vector-key',
      adminPassword: 'lifecycle-test-password',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir,
      webDistDir: null,
    };
    app = await createApplication(config);
  });
  afterEach(async () => {
    provider?.closeAllConnections();
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, 'exit');
      worker.kill('SIGKILL');
      await exited;
    }
    worker = undefined;
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

  it('部分清理暂停并重启后仍保持限制，恢复沿用已提交进度', async () => {
    await app.close();
    config = { ...config, lifecycleBatchSize: 1 };
    app = await createApplication(config);
    let agent = await login();
    const companion = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: '分批清理', initialProfile: '保留起点。' })
        .expect(201)
    ).body.data;
    const group = (
      await agent
        .post('/api/conversations')
        .send({
          requestId: randomUUID(),
          title: '清理检查点',
          kind: 'private',
          includeUser: true,
          companions: [{ companionId: companion.id, runtimeEpoch: 1 }],
        })
        .expect(201)
    ).body.data.conversation;
    const selected = [];
    let version = group.version;
    for (let i = 0; i < 24; i++) {
      const message = (
        await agent
          .post(`/api/conversations/${group.id}/messages`)
          .send({
            requestId: randomUUID(),
            speaker: { kind: 'user' },
            expectedConversationVersion: version,
            text: `需要清理的第 ${i} 条。`,
          })
          .expect(201)
      ).body.data;
      await agent
        .post(`/api/conversations/${group.id}/messages/${message.id}/publish`)
        .send({
          requestId: randomUUID(),
          expectedConversationVersion: version,
          expectedRevision: 1,
        })
        .expect(201);
      version++;
      selected.push({ messageId: message.id, contentVersion: 1 });
    }
    const operation = (
      await agent
        .post('/api/lifecycle')
        .send({
          requestId: randomUUID(),
          kind: 'delete_messages',
          conversationId: group.id,
          expectedVersion: version,
          messages: selected,
        })
        .expect(201)
    ).body.data;
    await app.get(TaskWorkerService).start();
    let partial;
    for (let i = 0; i < 200; i++) {
      partial = (await agent.get(`/api/lifecycle/${operation.id}`).expect(200)).body.data;
      if (partial.processedRecords > 0) break;
      await delay(5);
    }
    expect(partial.status).toBe('pending');
    expect(partial.processedRecords).toBeGreaterThan(0);
    await agent.post(`/api/tasks/${operation.task.id}/pause`).send({}).expect(200);
    const paused = (await agent.get(`/api/lifecycle/${operation.id}`).expect(200)).body.data;
    await app.close();
    app = await createApplication(config);
    agent = await login();
    const recovered = (await agent.get(`/api/lifecycle/${operation.id}`).expect(200)).body.data;
    expect(recovered.processedRecords).toBe(paused.processedRecords);
    expect(recovered.completedStages).toBe(paused.completedStages);
    await agent.get(`/api/conversations/${group.id}/messages`).expect(409);
    await agent
      .post(`/api/lifecycle/${operation.id}/retry`)
      .send({ requestId: randomUUID() })
      .expect(201);
    await app.get(TaskWorkerService).start();
    let completed;
    for (let i = 0; i < 200; i++) {
      completed = (await agent.get(`/api/lifecycle/${operation.id}`).expect(200)).body.data;
      if (completed.status === 'completed') break;
      await delay(10);
    }
    expect(completed.status).toBe('completed');
    const history = (
      await agent.get(`/api/conversations/${group.id}/messages?limit=100`).expect(200)
    ).body.data;
    expect(history.items).toHaveLength(24);
    expect(
      history.items.every((item: { deletedAt: string | null }) => item.deletedAt !== null),
    ).toBe(true);
  }, 20000);

  it('重复重置保留初始约束且不再次调用模型，私有上下文清除后仍能沿来源删除旧回复', async () => {
    const agent = await login();
    const pending = (
      await agent
        .post('/api/companion-creations')
        .send({
          requestId: randomUUID(),
          source: {
            kind: 'text',
            profileText: '阿澜住在海边，喜欢记录旅行。',
            lockedFeatures: ['保留独立思考'],
          },
        })
        .expect(201)
    ).body.data;
    await app.get(TaskWorkerService).start();
    let persona;
    for (let i = 0; i < 100; i++) {
      persona = (await agent.get(`/api/companions/${pending.companion.id}/persona`).expect(200))
        .body.data;
      if (persona.initialPersonaVersion) break;
      await delay(40);
    }
    expect(persona.initialPersonaVersion.document).not.toBeNull();
    const initial = persona.initialPersonaVersion.document;
    await agent
      .post(`/api/companions/${pending.companion.id}/persona/locks`)
      .send({
        requestId: randomUUID(),
        runtimeEpoch: 1,
        expectedPersonaVersion: persona.companion.currentPersonaVersion.version,
        lockedFeatures: ['后来追加的约束'],
      })
      .expect(201);
    const chat = (
      await agent
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          companionId: pending.companion.id,
          runtimeEpoch: 1,
          title: '有来源的旧回复',
        })
        .expect(201)
    ).body.data;
    const first = (
      await agent
        .post(`/api/chats/${chat.id}/messages`)
        .send({ requestId: randomUUID(), text: '曾经用过的暗号。' })
        .expect(201)
    ).body.data;
    let state;
    for (let i = 0; i < 100; i++) {
      state = (await agent.get(`/api/chats/${chat.id}`).expect(200)).body.data;
      if (state.currentRun?.status === 'succeeded') break;
      await delay(40);
    }
    expect(state.currentRun.status).toBe('succeeded');
    const usage = (await agent.get('/api/models/usage').expect(200)).body.data;
    for (const epoch of [1, 2]) {
      const companion = (await agent.get(`/api/companions/${pending.companion.id}`).expect(200))
        .body.data;
      const operation = (
        await agent
          .post('/api/lifecycle')
          .send({
            requestId: randomUUID(),
            kind: 'reset_companion',
            companionId: companion.id,
            runtimeEpoch: epoch,
            expectedVersion: companion.version,
          })
          .expect(201)
      ).body.data;
      let completed;
      for (let i = 0; i < 100; i++) {
        completed = (await agent.get(`/api/lifecycle/${operation.id}`).expect(200)).body.data;
        if (completed.status === 'completed') break;
        await delay(40);
      }
      expect(completed.status).toBe('completed');
      const reset = (await agent.get(`/api/companions/${companion.id}/persona`).expect(200)).body
        .data;
      expect(reset.companion.runtimeEpoch).toBe(epoch + 1);
      expect(reset.companion.currentPersonaVersion.document).toEqual(initial);
      expect(reset.initialPersonaVersion.document).toEqual(initial);
    }
    expect((await agent.get('/api/models/usage').expect(200)).body.data).toEqual(usage);
    const old = (await agent.get(`/api/chats/${chat.id}/messages`).expect(200)).body.data;
    expect(old.items).toHaveLength(2);
    expect(old.items[1].message.text).toContain('曾经用过的暗号');
    const conversation = (await agent.get(`/api/conversations/${chat.id}`).expect(200)).body.data
      .conversation;
    const operation = (
      await agent
        .post('/api/lifecycle')
        .send({
          requestId: randomUUID(),
          kind: 'delete_messages',
          conversationId: chat.id,
          expectedVersion: conversation.version,
          messages: [{ messageId: first.message.id, contentVersion: 1 }],
        })
        .expect(201)
    ).body.data;
    let completed;
    for (let i = 0; i < 100; i++) {
      completed = (await agent.get(`/api/lifecycle/${operation.id}`).expect(200)).body.data;
      if (completed.status === 'completed') break;
      await delay(40);
    }
    expect(completed.status).toBe('completed');
    const history = (await agent.get(`/api/chats/${chat.id}/messages`).expect(200)).body.data;
    expect(history.items.map((item: { message: { text: string } }) => item.message.text)).toEqual([
      '内容已删除',
      '内容已删除',
    ]);
  });
  it('模型尚未结束时另一进程也能完成重置，迟到回复不发布且用量继续结算', async () => {
    let response: ServerResponse | undefined;
    let externalRequests = 0;
    provider = createServer((_req, res) => {
      externalRequests++;
      response = res;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'data: {"choices":[{"index":0,"delta":{"content":"先前已说出。"},"finish_reason":null}]}\n\n',
      );
    });
    await new Promise<void>((resolve) => provider!.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('测试供应商未启动');
    await app.close();
    config = {
      ...config,
      modelDeployment: loadServerConfig({
        DATABASE_URL: config.databaseUrl,
        ADMIN_PASSWORD: config.adminPassword,
        QDRANT_URL: config.qdrantUrl,
        QDRANT_API_KEY: config.qdrantApiKey,
        MODEL_PROVIDERS_JSON: JSON.stringify([
          {
            id: 'fixture',
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKeyEnv: null,
            capabilities: ['text'],
            streaming: true,
          },
        ]),
      }).modelDeployment,
    };
    app = await createApplication(config);
    const agent = await login();
    const models = (await agent.get('/api/models/config').expect(200)).body.data;
    Object.assign(models.config.tasks.chat, {
      providerId: 'fixture',
      model: 'stream-test',
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
    });
    await agent
      .put('/api/models/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: models.version,
        config: models.config,
        evaluationNote: '验证跨进程重置与迟到用量。',
      })
      .expect(200);
    const scheduler = (await agent.get('/api/tasks/config').expect(200)).body.data;
    scheduler.config.maxConcurrent = 1;
    await agent
      .put('/api/tasks/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: scheduler.version,
        config: scheduler.config,
      })
      .expect(200);
    const companion = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: '阿澜', initialProfile: '保留独立思考。' })
        .expect(201)
    ).body.data;
    const chat = (
      await agent
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          companionId: companion.id,
          runtimeEpoch: 1,
          title: '在途生成',
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
      if (state.lastSequence >= 2) break;
      await delay(30);
    }
    expect(state.lastSequence).toBeGreaterThanOrEqual(2);
    const callId = state.currentRun.task.modelCallId;
    // 旧进程停止领取但仍等待在途模型，清理必须由独立子进程完成。
    const stopped = app.get(TaskWorkerService).stop();
    worker = spawn(
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
          MODEL_PROVIDERS_JSON: JSON.stringify([
            {
              id: 'fixture',
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              apiKeyEnv: null,
              capabilities: ['text'],
              streaming: true,
            },
          ]),
        },
      },
    );
    const url = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('清理子进程未就绪')), 5000);
      worker!.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        for (const line of output.split('\n').slice(0, -1)) {
          try {
            const value = JSON.parse(line) as { url?: string };
            if (value.url) {
              clearTimeout(timeout);
              resolve(value.url);
            }
          } catch {
            /* 等待完整就绪行。 */
          }
        }
      });
      worker!.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      worker!.once('exit', () => {
        clearTimeout(timeout);
        reject(new Error('清理子进程提前退出'));
      });
    });
    const other = request.agent(url);
    await other.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    const operation = (
      await other
        .post('/api/lifecycle')
        .send({
          requestId: randomUUID(),
          kind: 'reset_companion',
          companionId: companion.id,
          runtimeEpoch: 1,
          expectedVersion: companion.version,
        })
        .expect(201)
    ).body.data;
    let completed;
    for (let i = 0; i < 100; i++) {
      completed = (await other.get(`/api/lifecycle/${operation.id}`).expect(200)).body.data;
      if (completed.status === 'completed') break;
      await delay(30);
    }
    expect(completed.status).toBe('completed');
    response!.end(
      'data: {"choices":[{"index":0,"delta":{"content":"这段迟到，不能发布。"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":10}}\n\ndata: [DONE]\n\n',
    );
    await stopped;
    const history = (await other.get(`/api/chats/${chat.id}/messages`).expect(200)).body.data;
    expect(history.items.map((item: { message: { text: string } }) => item.message.text)).toEqual([
      '你好。',
      '先前已说出。',
    ]);
    const call = (await other.get(`/api/models/calls/${callId}`).expect(200)).body.data;
    expect(call.result).toBeNull();
    expect(externalRequests).toBe(1);
    expect(
      (await other.get('/api/models/usage').expect(200)).body.data.tasks.chat.charged.requests,
    ).toBe(1);
  });

  it('指定原文删除阻止旧输入继续生成，清除依赖回复与模型候选，独立原文和用量保留', async () => {
    const agent = await login();
    const companion = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: '阿澜', initialProfile: '住在海边。' })
        .expect(201)
    ).body.data;
    const chat = (
      await agent
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          companionId: companion.id,
          runtimeEpoch: 1,
          title: '删除片段',
        })
        .expect(201)
    ).body.data;
    const first = (
      await agent
        .post(`/api/chats/${chat.id}/messages`)
        .send({ requestId: randomUUID(), text: '我的私人暗号是青色风筝。' })
        .expect(201)
    ).body.data;
    await app.get(TaskWorkerService).start();
    let state;
    for (let i = 0; i < 100; i++) {
      state = (await agent.get(`/api/chats/${chat.id}`).expect(200)).body.data;
      if (state.currentRun?.status === 'succeeded') break;
      await delay(40);
    }
    expect(state.currentRun.status).toBe('succeeded');
    const callId = state.currentRun.task.modelCallId;
    await app.get(TaskWorkerService).stop();
    const independent = (
      await agent
        .post(`/api/chats/${chat.id}/messages`)
        .send({ requestId: randomUUID(), text: '今天晴天。' })
        .expect(201)
    ).body.data;
    const usage = (await agent.get('/api/models/usage').expect(200)).body.data;
    const conversation = (await agent.get(`/api/conversations/${chat.id}`).expect(200)).body.data
      .conversation;
    const operation = (
      await agent
        .post('/api/lifecycle')
        .send({
          requestId: randomUUID(),
          kind: 'delete_messages',
          conversationId: chat.id,
          expectedVersion: conversation.version,
          messages: [{ messageId: first.message.id, contentVersion: 1 }],
        })
        .expect(201)
    ).body.data;
    await agent.get(`/api/chats/${chat.id}/messages`).expect(409);
    expect(
      (await agent.get(`/api/models/calls/${callId}`).expect(200)).body.data.result,
    ).toBeNull();
    expect(JSON.stringify(operation)).not.toContain('青色风筝');
    await app.get(TaskWorkerService).start();
    let completed;
    for (let i = 0; i < 100; i++) {
      completed = (await agent.get(`/api/lifecycle/${operation.id}`).expect(200)).body.data;
      if (completed.status === 'completed') break;
      await delay(40);
    }
    expect(completed.status).toBe('completed');
    const history = (await agent.get(`/api/chats/${chat.id}/messages`).expect(200)).body.data;
    expect(JSON.stringify(history)).not.toContain('青色风筝');
    expect(
      history.items.find(
        (item: { message: { id: string } }) => item.message.id === first.message.id,
      ).message.deletedAt,
    ).toEqual(expect.any(String));
    expect(
      history.items.find(
        (item: { message: { id: string } }) => item.message.id === independent.message.id,
      ).message.text,
    ).toBe('今天晴天。');
    expect((await agent.get('/api/models/usage').expect(200)).body.data).toEqual(usage);
    await agent
      .get(
        `/api/companions/${companion.id}/sources/${first.message.id}?runtimeEpoch=1&contentVersion=1`,
      )
      .expect(404);
    await agent
      .post(`/api/chats/${chat.id}/messages`)
      .send({ requestId: randomUUID(), text: '继续散步。' })
      .expect(201);
    for (let i = 0; i < 100; i++) {
      state = (await agent.get(`/api/chats/${chat.id}`).expect(200)).body.data;
      if (state.currentRun?.status === 'succeeded') break;
      await delay(40);
    }
    expect(state.currentRun.status).toBe('succeeded');
    expect(
      state.currentRun.context.sources.some(
        (item: { messageId: string }) => item.messageId === first.message.id,
      ),
    ).toBe(false);
  });

  it('删除 A 只擦除 A 私有状态，B 已取得的共同原文与读取进度保留', async () => {
    const agent = await login();
    const a = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: 'A', initialProfile: 'A 的私有人设。' })
        .expect(201)
    ).body.data;
    const b = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: 'B', initialProfile: 'B 的私有人设。' })
        .expect(201)
    ).body.data;
    const group = (
      await agent
        .post('/api/conversations')
        .send({
          requestId: randomUUID(),
          title: '共同经历',
          kind: 'group',
          includeUser: true,
          companions: [
            { companionId: a.id, runtimeEpoch: 1 },
            { companionId: b.id, runtimeEpoch: 1 },
          ],
        })
        .expect(201)
    ).body.data.conversation;
    const draft = (
      await agent
        .post(`/api/conversations/${group.id}/messages`)
        .send({
          requestId: randomUUID(),
          speaker: { kind: 'companion', companionId: a.id, runtimeEpoch: 1 },
          expectedConversationVersion: 1,
          text: '我们一起看过海。',
        })
        .expect(201)
    ).body.data;
    await agent
      .post(`/api/conversations/${group.id}/messages/${draft.id}/publish`)
      .send({ requestId: randomUUID(), expectedConversationVersion: 1, expectedRevision: 1 })
      .expect(201);
    await agent
      .post(`/api/companions/${b.id}/conversations/${group.id}/receive`)
      .send({ requestId: randomUUID(), runtimeEpoch: 1, expectedPermissionVersion: 1 })
      .expect(201);
    const before = (
      await agent
        .get(`/api/companions/${b.id}/conversations/${group.id}/progress?runtimeEpoch=1`)
        .expect(200)
    ).body.data;
    const operation = (
      await agent
        .post('/api/lifecycle')
        .send({
          requestId: randomUUID(),
          kind: 'delete_companion',
          companionId: a.id,
          runtimeEpoch: 1,
          expectedVersion: 1,
        })
        .expect(201)
    ).body.data;
    await agent.get(`/api/companions/${a.id}`).expect(404);
    await app.get(TaskWorkerService).start();
    let completed;
    for (let i = 0; i < 100; i++) {
      completed = (await agent.get(`/api/lifecycle/${operation.id}`).expect(200)).body.data;
      if (completed.status === 'completed') break;
      await delay(40);
    }
    expect(completed.status).toBe('completed');
    expect((await agent.get(`/api/companions/${b.id}`).expect(200)).body.data).toEqual(b);
    expect(
      (
        await agent
          .get(`/api/companions/${b.id}/conversations/${group.id}/progress?runtimeEpoch=1`)
          .expect(200)
      ).body.data,
    ).toEqual(before);
    const history = (await agent.get(`/api/conversations/${group.id}/messages`).expect(200)).body
      .data;
    expect(history.items[0].text).toBe('我们一起看过海。');
    const detail = (await agent.get(`/api/conversations/${group.id}`).expect(200)).body.data;
    expect(
      detail.members.find((item: { companionId: string }) => item.companionId === a.id).deletedAt,
    ).toEqual(expect.any(String));
    await agent.get(`/api/companions/${a.id}/persona/versions/1?runtimeEpoch=1`).expect(404);
    const aTasks = (await agent.get(`/api/tasks?companionId=${a.id}&limit=100`).expect(200)).body
      .data.items;
    const bTasks = (await agent.get(`/api/tasks?companionId=${b.id}&limit=100`).expect(200)).body
      .data.items;
    const next = (
      await agent
        .post(`/api/conversations/${group.id}/messages`)
        .send({
          requestId: randomUUID(),
          speaker: { kind: 'user' },
          expectedConversationVersion: detail.conversation.version,
          text: 'B 还可以继续交流。',
        })
        .expect(201)
    ).body.data;
    await agent
      .post(`/api/conversations/${group.id}/messages/${next.id}/publish`)
      .send({
        requestId: randomUUID(),
        expectedConversationVersion: detail.conversation.version,
        expectedRevision: next.revision,
      })
      .expect(201);
    let laterB;
    for (let i = 0; i < 100; i++) {
      laterB = (await agent.get(`/api/tasks?companionId=${b.id}&limit=100`).expect(200)).body.data
        .items;
      if (laterB.length > bTasks.length) break;
      await delay(40);
    }
    expect(laterB.length).toBeGreaterThan(bTasks.length);
    expect(
      (await agent.get(`/api/tasks?companionId=${a.id}&limit=100`).expect(200)).body.data.items,
    ).toEqual(aTasks);
  });

  it('重置先限制旧代次，重启后清理完成；同键重试不再次重置，初始快照保留', async () => {
    let agent = await login();
    const original = (
      await agent
        .post('/api/companions')
        .send({
          requestId: randomUUID(),
          name: '阿澜',
          initialProfile: '出生在海边，始终保留独立思考。',
        })
        .expect(201)
    ).body.data;
    const chat = (
      await agent
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          companionId: original.id,
          runtimeEpoch: 1,
          title: '重置前',
        })
        .expect(201)
    ).body.data;
    await agent
      .post(`/api/chats/${chat.id}/messages`)
      .send({ requestId: randomUUID(), text: '这一段属于旧经历。' })
      .expect(201);
    const command = {
      requestId: randomUUID(),
      kind: 'reset_companion',
      companionId: original.id,
      runtimeEpoch: 1,
      expectedVersion: original.version,
    };
    const operation = (await agent.post('/api/lifecycle').send(command).expect(201)).body.data;
    expect(operation).toMatchObject({ kind: 'reset_companion', status: 'pending', nextEpoch: 2 });
    await agent
      .post(`/api/chats/${chat.id}/messages`)
      .send({ requestId: randomUUID(), text: '旧轮不能继续' })
      .expect(409);
    await agent.post(`/api/tasks/${operation.task.id}/cancel`).send({}).expect(200);
    await app.close();
    app = await createApplication(config);
    agent = await login();
    expect(
      (await agent.get(`/api/lifecycle/${operation.id}`).expect(200)).body.data.task.status,
    ).toBe('cancelled');
    await agent
      .post('/api/chats')
      .send({
        requestId: randomUUID(),
        companionId: original.id,
        runtimeEpoch: 2,
        title: '清理前不能开始',
      })
      .expect(409);
    const retry = { requestId: randomUUID() };
    const resumed = (
      await agent.post(`/api/lifecycle/${operation.id}/retry`).send(retry).expect(201)
    ).body.data;
    expect(resumed.task.id).not.toBe(operation.task.id);
    expect(
      (await agent.post(`/api/lifecycle/${operation.id}/retry`).send(retry).expect(201)).body.data
        .task.id,
    ).toBe(resumed.task.id);
    const replay = (await agent.post('/api/lifecycle').send(command).expect(201)).body.data;
    expect(replay.id).toBe(operation.id);
    await app.get(TaskWorkerService).start();
    let completed;
    for (let i = 0; i < 100; i++) {
      completed = (await agent.get(`/api/lifecycle/${operation.id}`).expect(200)).body.data;
      if (completed.status === 'completed') break;
      await delay(40);
    }
    expect(completed).toMatchObject({ status: 'completed', task: { status: 'succeeded' } });
    const current = (await agent.get(`/api/companions/${original.id}`).expect(200)).body.data;
    expect(current).toMatchObject({
      runtimeEpoch: 2,
      initialSnapshot: original.initialSnapshot,
      currentPersonaVersion: { version: 1, profileText: original.initialSnapshot.profileText },
    });
    await agent.get(`/api/companions/${original.id}/persona/versions/1?runtimeEpoch=1`).expect(409);
    const history = (await agent.get(`/api/conversations/${chat.id}/messages`).expect(200)).body
      .data;
    expect(history.items.map((item: { text: string }) => item.text)).toEqual([
      '这一段属于旧经历。',
    ]);
    const oldChat = (await agent.get(`/api/chats/${chat.id}`).expect(200)).body.data;
    expect(oldChat.availability).toBe('archived');
    await agent
      .post('/api/chats')
      .send({
        requestId: randomUUID(),
        companionId: original.id,
        runtimeEpoch: 2,
        title: '新一段人生',
      })
      .expect(201);
    await agent.post('/api/lifecycle').send(command).expect(201);
    expect(
      (await agent.get(`/api/companions/${original.id}`).expect(200)).body.data.runtimeEpoch,
    ).toBe(2);
  });
});
