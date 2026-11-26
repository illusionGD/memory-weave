import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { activitySchema } from '@memory-weave/contracts';
import type { Activity, ActivityScope } from '@memory-weave/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app';
import type { ServerConfig } from '../src/config';
import { ModelRuntimeService } from '../src/modules/models/model-runtime.service';
import { TaskWorkerService } from '../src/modules/tasks/task-worker.service';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';
import { createTestAuthConfig, disposeTestAuth } from './support/redis';

afterAll(disposeTestAuth);

describe('F13 活动公开协议', () => {
  let app: INestApplication;
  let config: ServerConfig;
  let database: TestDatabase;
  let directory: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    directory = await mkdtemp(join(tmpdir(), 'memory-weave-activities-'));
    config = {
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      qdrantUrl: 'http://127.0.0.1:1',
      qdrantApiKey: 'isolated-vector-key',
      ...createTestAuthConfig(),
      adminPassword: 'activities-test-password',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir: directory,
      webDistDir: null,
    };
    app = await createApplication(config);
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await database?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30_000);

  /** 通过真实认证入口取得账号会话。 */
  async function login() {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    return agent;
  }

  /** 建立独立伴侣及其私聊。 */
  async function makeScope(
    agent: Awaited<ReturnType<typeof login>>,
    name: string,
  ): Promise<ActivityScope> {
    const companion = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name, initialProfile: '依据实际结果交流。' })
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
    return { companionId: companion.id, conversationId: chat.id, runtimeEpoch: 1 };
  }

  /** 从公开接口等待指定活动最终成功。 */
  async function completed(
    agent: Awaited<ReturnType<typeof login>>,
    id: string,
  ): Promise<Activity> {
    return vi.waitFor(
      async () => {
        const result = (await agent.get(`/api/activities/${id}`).expect(200)).body.data;
        expect(result.task.status, JSON.stringify(result.task)).toBe('succeeded');
        return activitySchema.parse(result);
      },
      { timeout: 15000, interval: 100 },
    );
  }

  it('写作状态、作品版本与交付确认在应用重启后恢复', async () => {
    let agent = await login();
    const scope = await makeScope(agent, '写作伴侣');
    const command = {
      ...scope,
      requestId: randomUUID(),
      specification: { kind: 'write', goal: '写一段关于小镇的开场。' },
    };
    await request(app.getHttpServer()).post('/api/activities').send(command).expect(401);
    const response = await agent.post('/api/activities').send(command).expect(201);
    const first = activitySchema.parse(response.body.data);
    expect(first).toMatchObject({
      version: 1,
      delivery: 'unavailable',
      artifact: null,
      task: { status: 'queued' },
    });
    await agent.post(`/api/activities/${first.id}/versions/1/acknowledge`).expect(409);
    await agent
      .post('/api/activities')
      .send({
        ...command,
        specification: { kind: 'write', goal: '同键不同目标' },
      })
      .expect(409);
    expect(
      (await agent.get('/api/activities').query(scope).expect(200)).body.data.items[0].id,
    ).toBe(first.id);
    await app.close();
    app = await createApplication(config);
    agent = await login();
    const replay = (await agent.post('/api/activities').send(command).expect(201)).body.data;
    expect(replay.task.id).toBe(first.task.id);
    await app.get(TaskWorkerService).start();
    expect(await completed(agent, first.id)).toMatchObject({
      artifact: { text: expect.stringContaining('测试草稿'), kind: 'write', mode: 'test' },
      delivery: 'available',
      acknowledgedAt: null,
      task: { progress: { completedSteps: 2 } },
    });
    const path = `/api/activities/${first.id}/versions/1/acknowledge`;
    const ack = (await agent.post(path).expect(200)).body.data;
    expect(ack).toMatchObject({ delivery: 'acknowledged', acknowledgedAt: expect.any(String) });
    expect((await agent.post(path).expect(200)).body.data.acknowledgedAt).toBe(ack.acknowledgedAt);
    const revision = {
      requestId: randomUUID(),
      expectedVersion: 1,
      specification: { kind: 'write', goal: '续写第二章。' },
    };
    const revised = (
      await agent.post(`/api/activities/${first.id}/revisions`).send(revision).expect(200)
    ).body.data;
    expect(revised).toMatchObject({ version: 2, currentVersion: 2, delivery: 'unavailable' });
    await agent
      .post(`/api/activities/${first.id}/revisions`)
      .send({ ...revision, requestId: randomUUID() })
      .expect(409);
    expect(
      (await agent.post(`/api/activities/${first.id}/revisions`).send(revision).expect(200)).body
        .data.task.id,
    ).toBe(revised.task.id);
    expect(
      (await agent.get(`/api/activities/${first.id}/versions/1`).expect(200)).body.data,
    ).toMatchObject({
      version: 1,
      currentVersion: 2,
      delivery: 'acknowledged',
      acknowledgedAt: ack.acknowledgedAt,
    });
    const newest = (await agent.get(`/api/activities/${first.id}/versions?limit=1`).expect(200))
      .body.data;
    expect(newest).toMatchObject({ items: [{ version: 2 }], nextBeforeVersion: 2 });
    expect(
      (await agent.get(`/api/activities/${first.id}/versions?beforeVersion=2`).expect(200)).body
        .data,
    ).toMatchObject({ items: [{ version: 1 }], nextBeforeVersion: null });
  }, 30000);

  it('修改目标撤销正在生成的旧结果写入资格', async () => {
    const agent = await login();
    const scope = await makeScope(agent, '版本伴侣');
    const runtime = app.get(ModelRuntimeService);
    const execute = runtime.execute.bind(runtime);
    let release = () => {};
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    let received = false;
    vi.spyOn(runtime, 'execute').mockImplementation(async (...args) => {
      const result = await execute(...args);
      if (args[1].inputText.includes('旧版本专用词') && args[1].inputText.includes('outline')) {
        received = true;
        await pause;
      }
      return result;
    });
    const first = (
      await agent
        .post('/api/activities')
        .send({
          ...scope,
          requestId: randomUUID(),
          specification: { kind: 'write', goal: '旧版本专用词' },
        })
        .expect(201)
    ).body.data;
    try {
      await app.get(TaskWorkerService).start();
      await vi.waitFor(() => expect(received).toBe(true), { timeout: 12000 });
      const waiting = (await agent.get(`/api/activities/${first.id}`).expect(200)).body.data;
      expect(waiting).toMatchObject({
        artifact: null,
        task: { status: 'running', progress: { completedSteps: 1 } },
      });
      await agent
        .post(`/api/activities/${first.id}/revisions`)
        .send({
          requestId: randomUUID(),
          expectedVersion: 1,
          specification: { kind: 'write', goal: '新版本专用词' },
        })
        .expect(200);
    } finally {
      release();
    }
    expect(await completed(agent, first.id)).toMatchObject({
      version: 2,
      artifact: { kind: 'write' },
    });
    expect(
      (await agent.get(`/api/activities/${first.id}/versions/1`).expect(200)).body.data,
    ).toMatchObject({
      artifact: null,
      delivery: 'unavailable',
      task: { status: 'cancelled', progress: { completedSteps: 1 } },
    });
  }, 30000);

  it('暂停后重启可复用已确认模型结果并从检查点完成交付', async () => {
    let agent = await login();
    const scope = await makeScope(agent, '恢复伴侣');
    const runtime = app.get(ModelRuntimeService);
    const execute = runtime.execute.bind(runtime);
    let release = () => {};
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    let previousCallId: string | undefined;
    let outlineCalls = 0;
    vi.spyOn(runtime, 'execute').mockImplementation(async (...args) => {
      const result = await execute(...args);
      if (args[1].inputText.includes('恢复检查点专用词')) {
        if (args[1].inputText.includes('outline')) {
          previousCallId = result.id;
          await pause;
        } else {
          outlineCalls += 1;
        }
      }
      return result;
    });
    const first = (
      await agent
        .post('/api/activities')
        .send({
          ...scope,
          requestId: randomUUID(),
          specification: { kind: 'write', goal: '恢复检查点专用词' },
        })
        .expect(201)
    ).body.data;
    try {
      await app.get(TaskWorkerService).start();
      await vi.waitFor(() => expect(previousCallId).toEqual(expect.any(String)), {
        timeout: 12000,
      });
      await agent.post(`/api/tasks/${first.task.id}/pause`).expect(200);
      expect((await agent.get(`/api/activities/${first.id}`).expect(200)).body.data).toMatchObject({
        artifact: null,
        task: { status: 'paused', progress: { completedSteps: 1 } },
      });
    } finally {
      release();
    }
    expect(outlineCalls).toBe(1);
    await app.close();
    app = await createApplication(config);
    agent = await login();
    await agent.post(`/api/tasks/${first.task.id}/resume`).expect(200);
    await app.get(TaskWorkerService).start();
    expect(await completed(agent, first.id)).toMatchObject({
      task: {
        modelCallId: previousCallId,
        attempts: [
          { number: 1, status: 'paused' },
          { number: 2, status: 'succeeded' },
        ],
      },
      artifact: { kind: 'write' },
    });
    expect(
      (await agent.get(`/api/models/calls/${previousCallId}`).expect(200)).body.data.attempts,
    ).toHaveLength(1);
  }, 30000);

  it('只采用确切分享中的实际片段，删除来源后原成果不可读', async () => {
    const agent = await login();
    const scope = await makeScope(agent, '阅读伴侣');
    const other = await makeScope(agent, '另一伴侣');
    const material = (
      await agent
        .put('/api/materials')
        .query({ requestId: randomUUID(), filename: '资料.md', kind: 'markdown' })
        .set('content-type', 'application/octet-stream')
        .send(Buffer.from('# 研究记录\n\n' + '超长合成文本。'.repeat(55)))
        .expect(200)
    ).body.data;
    const shared = (
      await agent
        .post(`/api/chats/${scope.conversationId}/messages`)
        .send({
          requestId: randomUUID(),
          text: '',
          materialIds: [material.id],
        })
        .expect(201)
    ).body.data.message;
    const write = {
      requestId: randomUUID(),
      specification: {
        kind: 'read',
        goal: '整理研究记录的两个片段。',
        source: {
          materialId: material.id,
          messageId: shared.id,
          contentVersion: shared.contentVersion,
        },
        range: { from: 1, through: 2 },
      },
    };
    await agent
      .post('/api/activities')
      .send({ ...other, ...write })
      .expect(404);
    const read = (
      await agent
        .post('/api/activities')
        .send({ ...scope, ...write })
        .expect(201)
    ).body.data;
    const missing = (
      await agent
        .post('/api/activities')
        .send({
          ...scope,
          requestId: randomUUID(),
          specification: { ...write.specification, range: { from: 3, through: 3 } },
        })
        .expect(201)
    ).body.data;
    expect(missing.task).toMatchObject({
      status: 'blocked',
      reason: 'activity_material_range_missing',
      attempts: [],
    });
    await app.get(TaskWorkerService).start();
    const coverage = [
      { position: 1, status: 'included' },
      { position: 2, status: 'truncated' },
    ];
    expect(await completed(agent, read.id)).toMatchObject({
      coverage,
      artifact: { kind: 'read', coverage },
    });
    await app.get(TaskWorkerService).stop();
    const version = (await agent.get(`/api/conversations/${scope.conversationId}`).expect(200)).body
      .data.conversation.version;
    const operation = (
      await agent
        .post('/api/lifecycle')
        .send({
          requestId: randomUUID(),
          kind: 'delete_messages',
          conversationId: scope.conversationId,
          expectedVersion: version,
          messages: [{ messageId: shared.id, contentVersion: shared.contentVersion }],
        })
        .expect(201)
    ).body.data;
    await agent.get(`/api/activities/${read.id}`).expect(409);
    await app.get(TaskWorkerService).start();
    await vi.waitFor(
      async () => {
        expect(
          (await agent.get(`/api/lifecycle/${operation.id}`).expect(200)).body.data.completedAt,
        ).toEqual(expect.any(String));
      },
      { timeout: 15000, interval: 100 },
    );
    await agent.get(`/api/activities/${read.id}`).expect(404);
    expect((await agent.get('/api/activities').query(scope).expect(200)).body.data.items).toEqual(
      [],
    );
    await agent
      .post('/api/activities')
      .send({ ...scope, ...write })
      .expect(404);
  }, 30000);

  it('离线与未核对回执只等待，核对同一动作后恢复活动', async () => {
    const agent = await login();
    const scope = await makeScope(agent, '终端伴侣');
    const terminalId = randomUUID();
    const secret = randomBytes(32).toString('hex');
    const base = `/api/terminals/${terminalId}`;
    const grant = { ...scope, workspaceId: 'fixture', tool: 'diagnostic.echo' };
    await agent.put(base).send({ secret, name: '隔离终端' }).expect(200);
    await agent
      .put(`${base}/grants`)
      .send({ ...grant, expectedVersion: 0, enabled: true })
      .expect(200);
    const action = (
      await agent
        .post('/api/terminals/actions')
        .send({
          ...grant,
          terminalId,
          requestId: randomUUID(),
          arguments: { text: '已运行' },
        })
        .expect(201)
    ).body.data;
    const activity = (
      await agent
        .post('/api/activities')
        .send({
          ...scope,
          requestId: randomUUID(),
          specification: {
            kind: 'write',
            goal: '保存终端确认后的样稿。',
            dependsOnActionId: action.id,
          },
        })
        .expect(201)
    ).body.data;
    expect(activity.task).toMatchObject({
      status: 'waiting',
      reason: 'activity_terminal_pending',
      attempts: [],
    });
    await app.get(TaskWorkerService).start();
    const device = request(app.getHttpServer());
    /** 使用设备专用凭据连接。 */
    const connect = async () =>
      (
        await device
          .post(`${base}/connect`)
          .set('authorization', `Bearer ${secret}`)
          .send({
            workspaceId: 'fixture',
            capabilities: ['diagnostic.echo'],
          })
          .expect(200)
      ).body.data.connectionId;
    const connectionId = await connect();
    const claim = (
      await device
        .post(`${base}/claim`)
        .set('authorization', `Bearer ${secret}`)
        .send({ connectionId })
        .expect(200)
    ).body.data;
    expect(claim.id).toBe(action.id);
    await device
      .post(`${base}/disconnect`)
      .set('authorization', `Bearer ${secret}`)
      .send({ connectionId })
      .expect(200);
    expect(
      (await agent.get(`/api/terminals/actions/${action.id}`).expect(200)).body.data.state,
    ).toBe('unknown');
    expect((await agent.get(`/api/activities/${activity.id}`).expect(200)).body.data).toMatchObject(
      {
        artifact: null,
        task: { status: 'waiting', progress: { completedSteps: 0 }, attempts: [] },
      },
    );
    const reconnected = await connect();
    await device
      .put(`${base}/actions/${action.id}/receipt`)
      .set('authorization', `Bearer ${secret}`)
      .send({
        connectionId: reconnected,
        claimId: claim.claimId,
        outcome: { state: 'succeeded', result: { text: '已运行' } },
      })
      .expect(200);
    expect(await completed(agent, activity.id)).toMatchObject({
      delivery: 'available',
      task: { attempts: [{ number: 1, status: 'succeeded' }] },
    });
  }, 30000);
});
