import { createServer } from 'node:http';
import { once } from 'node:events';
import { memoryConfigurationSchema } from '@memory-weave/contracts';
import { defaultModelHardLimits } from '../src/modules/models/model-deployment';
import { randomUUID } from 'node:crypto';
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

describe('F11 材料公开 HTTP', () => {
  let app: INestApplication;
  let config: ServerConfig;
  let database: TestDatabase;
  let dataDir: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    dataDir = await mkdtemp(join(tmpdir(), 'memory-weave-materials-'));
    config = {
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      qdrantUrl: process.env.TEST_QDRANT_URL ?? 'http://127.0.0.1:1',
      qdrantApiKey: process.env.TEST_QDRANT_API_KEY ?? 'test-vector-key',
      ...createTestAuthConfig(),
      adminPassword: 'materials-test-password',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir,
      webDistDir: null,
    };
    app = await createApplication(config);
  }, 30_000);
  afterEach(async () => {
    await app?.close();
    await database?.dispose();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }, 30_000);

  /** 通过真实认证获得该隔离部署的公开操作入口。 */
  async function login() {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    return agent;
  }

  it('上传材料、同键重放与只发材料能够进入有界回复上下文', async () => {
    const agent = await login();
    const input = { requestId: randomUUID(), filename: '星空.md', kind: 'markdown' };
    const body = Buffer.from('# 星空\n\n材料里的地址是星河路八号。');
    const upload = (bytes: Buffer) =>
      agent
        .put('/api/materials')
        .query(input)
        .set('Content-Type', 'application/octet-stream')
        .send(bytes);
    const first = await upload(body);
    expect(first.status, first.body.message).toBe(200);
    const material = first.body.data;
    expect(material).toMatchObject({ title: '星空.md', state: 'parsed', partCount: 2 });
    expect((await upload(body).expect(200)).body.data.id).toBe(material.id);
    await upload(Buffer.from('不同正文')).expect(409);
    expect((await agent.get(`/api/materials/${material.id}/original`).expect(200)).body).toEqual(
      body,
    );
    await request(app.getHttpServer()).get(`/api/materials/${material.id}/original`).expect(401);
    const parts = await agent.get(`/api/materials/${material.id}/parts?limit=1`).expect(200);
    expect(parts.body.data).toMatchObject({
      items: [{ position: 1, text: '# 星空' }],
      nextAfter: 1,
    });
    const companion = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: '阿澜', initialProfile: '执着于证据。' })
        .expect(201)
    ).body.data;
    const chat = (
      await agent
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          companionId: companion.id,
          runtimeEpoch: 1,
          title: '材料',
        })
        .expect(201)
    ).body.data;
    const send = (materialIds: string[], requestId: string) =>
      agent.post(`/api/chats/${chat.id}/messages`).send({ requestId, text: '', materialIds });
    await send([randomUUID()], randomUUID()).expect(404);
    const key = randomUUID();
    const sent = (await send([material.id], key).expect(201)).body.data;
    expect(sent.message).toMatchObject({ text: '', materials: [{ id: material.id }] });
    expect((await send([material.id], key).expect(201)).body.data.message.id).toBe(sent.message.id);
    await send([randomUUID()], key).expect(409);
    await app.get(TaskWorkerService).start();
    let run;
    for (let i = 0; i < 100; i++) {
      run = (await agent.get(`/api/chats/${chat.id}`).expect(200)).body.data.currentRun;
      if (['succeeded', 'failed', 'blocked'].includes(run.status)) break;
      await delay(35);
    }
    expect(run).toMatchObject({
      status: 'succeeded',
      context: {
        materials: [
          {
            materialId: material.id,
            excerpts: [
              { position: 1, text: '# 星空' },
              { position: 2, text: '材料里的地址是星河路八号。' },
            ],
          },
        ],
      },
    });
  });

  it('分别保存感知观察、网页访问限制和全文总结的实际覆盖', async () => {
    config.chatConfiguration = {
      mergeWindowMs: 30,
      maxMergeWaitMs: 100,
      historyMessages: 20,
      publishChunkChars: 256,
      publishIntervalMs: 100,
      eventPollMs: 250,
      maxEventConnections: 8,
    };
    await app.close();
    app = await createApplication(config);
    const agent = await login();
    const setting = (await agent.get('/api/models/config').expect(200)).body.data;
    setting.config.tasks.perception.enabled = true;
    await agent
      .put('/api/models/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: setting.version,
        config: setting.config,
        evaluationNote: '使用确定性视觉 adapter 验证真实输入路径。',
      })
      .expect(200);
    const companion = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: '阿澜', initialProfile: '区分观察与事实。' })
        .expect(201)
    ).body.data;
    const chat = (
      await agent
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          companionId: companion.id,
          runtimeEpoch: 1,
          title: '材料',
        })
        .expect(201)
    ).body.data;
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
      'base64',
    );
    const upload = async (kind: string, filename: string, body: Buffer) => {
      const response = await agent
        .put('/api/materials')
        .query({ requestId: randomUUID(), filename, kind })
        .set('Content-Type', 'application/octet-stream')
        .send(body);
      expect(response.status, response.body.message).toBe(200);
      return response.body.data;
    };
    const image = await upload('png', '照片.png', png);
    const article = await upload(
      'text',
      '长文.txt',
      Buffer.from('星空札记包含这段材料和末尾内容。'.repeat(350)),
    );
    await agent
      .get(`/api/materials/${image.id}/preview`)
      .expect(200)
      .expect('Content-Type', /image\/jpeg/);
    const reply = await agent
      .post(`/api/chats/${chat.id}/messages`)
      .send({
        requestId: randomUUID(),
        text: '分享 https://127.0.0.1/limited',
        materialIds: [image.id, article.id],
      })
      .expect(201);
    const user = reply.body.data.message;
    const web = user.materials.find((item: { kind: string }) => item.kind === 'web');
    await app.get(TaskWorkerService).start();
    let state;
    for (let i = 0; i < 150; i++) {
      state = (await agent.get(`/api/chats/${chat.id}`).expect(200)).body.data.currentRun;
      if (['succeeded', 'failed', 'blocked'].includes(state.status)) break;
      await delay(45);
    }
    expect(state).toMatchObject({ status: 'succeeded' });
    expect(state.context.materials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          materialId: image.id,
          observation: expect.objectContaining({ region: null }),
        }),
        expect.objectContaining({
          materialId: web.id,
          state: 'unavailable',
          reason: 'unsafe-address',
        }),
      ]),
    );
    const summaryRequest = {
      requestId: randomUUID(),
      messageId: user.id,
      contentVersion: user.contentVersion,
    };
    const summaryPath = `/api/materials/${article.id}/summaries`;
    const create = () => agent.post(summaryPath).send(summaryRequest).expect(201);
    const job = (await create()).body.data;
    expect((await create()).body.data.taskId).toBe(job.taskId);
    let result;
    for (let i = 0; i < 150; i++) {
      result = (await agent.get(`${summaryPath}/${job.taskId}`).expect(200)).body.data;
      if (['succeeded', 'failed', 'blocked'].includes(result.state)) break;
      await delay(45);
    }
    expect(result).toMatchObject({
      state: 'succeeded',
      coveredParts: 1,
      totalParts: 1,
      partial: false,
    });
    expect(result.batches.length).toBeGreaterThan(1);
    expect(
      (
        await agent
          .get(summaryPath)
          .query({ messageId: user.id, contentVersion: user.contentVersion })
          .expect(200)
      ).body.data,
    ).toMatchObject({ taskId: job.taskId });
  }, 30_000);

  it('由兼容协议处理图像预算，并从已读取的材料生成带定位的记忆证据', async () => {
    let imageData: unknown;
    let quotedMaterial: unknown;
    const fixture = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming as AsyncIterable<Buffer>) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString()) as {
        model: string;
        messages: { content: unknown }[];
      };
      const content = payload.messages.at(-1)?.content;
      let output: unknown = { actions: [] };
      if (payload.model === 'f11-vision') {
        imageData = content;
        output = { description: '可见一个亮色区域。', uncertainty: '看不清图中的主体。' };
      } else if (typeof content === 'string') {
        const input = JSON.parse(content) as {
          messages: {
            messageId: string;
            contentVersion: number;
            materials?: { locator: { kind: string }; text: string }[];
          }[];
        };
        const source = input.messages.find((message) =>
          message.materials?.some((item) => item.locator.kind === 'material-text'),
        );
        const part = source?.materials?.find((item) => item.locator.kind === 'material-text');
        if (source && part) {
          quotedMaterial = part.locator;
          output = {
            actions: [
              {
                action: 'add',
                targetId: null,
                targetVersion: null,
                revisionKind: null,
                reason: '作为文章所述内容保留引用。',
                evidence: [
                  {
                    messageId: source.messageId,
                    contentVersion: source.contentVersion,
                    quote: part.text,
                    material: part.locator,
                  },
                ],
                document: {
                  kind: 'semantic',
                  claim: 'fact',
                  subject: { kind: 'other', name: '作者' },
                  text: '作者写道，海边有灯塔。',
                  reality: 'real',
                  storyKey: null,
                  epistemic: 'report',
                  eventTime: null,
                  validFrom: null,
                  validUntil: null,
                },
              },
            ],
          };
        }
      }
      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      outgoing.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }],
        }),
      );
    });
    fixture.listen(0, '127.0.0.1');
    await once(fixture, 'listening');
    try {
      const address = fixture.address();
      if (!address || typeof address === 'string') throw new Error('没有测试模型地址');
      await app.close();
      config.memoryConfiguration = memoryConfigurationSchema.parse({ enabled: false });
      config.modelDeployment = {
        hardLimits: defaultModelHardLimits(),
        providers: [
          {
            id: 'f11-protocol',
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: null,
            apiKeyEnv: null,
            capabilities: ['structured'],
            streaming: false,
            visionInputTokens: 1200,
            outputTokenParameter: 'max_tokens',
            structuredFormat: 'json_object',
            sendEmbeddingDimensions: true,
          },
        ],
      };
      app = await createApplication(config);
      const agent = await login();
      const setting = (await agent.get('/api/models/config').expect(200)).body.data;
      for (const [role, model] of [
        ['perception', 'f11-vision'],
        ['memory', 'f11-memory'],
      ] as const)
        Object.assign(setting.config.tasks[role], {
          enabled: true,
          model,
          providerId: 'f11-protocol',
          inputMicrosPerMillion: 0,
          outputMicrosPerMillion: 0,
        });
      await agent
        .put('/api/models/config')
        .send({
          requestId: randomUUID(),
          expectedVersion: setting.version,
          config: setting.config,
          evaluationNote: '验证图像协议与材料证据。',
        })
        .expect(200);
      const companion = (
        await agent
          .post('/api/companions')
          .send({
            requestId: randomUUID(),
            name: '阿溪',
            initialProfile: '认真区分引文与观察。',
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
            title: '材料溯源',
          })
          .expect(201)
      ).body.data;
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
        'base64',
      );
      const files = [
        { kind: 'png', filename: '亮色.png', bytes: png },
        { kind: 'text', filename: '海边.txt', bytes: Buffer.from('作者写道，海边有灯塔。') },
      ];
      const materialIds: string[] = [];
      for (const { kind, filename, bytes } of files) {
        const upload = await agent
          .put('/api/materials')
          .query({ requestId: randomUUID(), kind, filename })
          .set('Content-Type', 'application/octet-stream')
          .send(bytes)
          .expect(200);
        materialIds.push(upload.body.data.id);
      }
      await agent
        .post(`/api/chats/${chat.id}/messages`)
        .send({
          requestId: randomUUID(),
          text: '这是照片和原文。',
          materialIds,
        })
        .expect(201);
      await app.get(TaskWorkerService).start();
      let run;
      for (let i = 0; i < 200; i++) {
        run = (await agent.get(`/api/chats/${chat.id}`).expect(200)).body.data.currentRun;
        if (['succeeded', 'blocked', 'failed'].includes(run.status)) break;
        await delay(50);
      }
      expect(run).toMatchObject({ status: 'succeeded' });
      expect(imageData).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'image_url',
            image_url: expect.objectContaining({
              url: expect.stringMatching(/^data:image\/jpeg;base64,/u),
            }),
          }),
        ]),
      );
      const context = run.context.materials.find(
        (item: { materialId: string }) => item.materialId === materialIds[0],
      );
      const call = (
        await agent.get(`/api/models/calls/${context.observation.modelCallId}`).expect(200)
      ).body.data;
      expect(call.attempts[0].usageSource).toBe('reserved');
      expect(call.attempts[0].chargedTokens).toBeGreaterThan(1200);
      const base = `/api/companions/${companion.id}/memories`;
      const scope = { runtimeEpoch: 1, conversationId: chat.id };
      const batch = (
        await agent
          .post(`${base}/organize`)
          .send({ ...scope, requestId: randomUUID() })
          .expect(201)
      ).body.data;
      let task;
      for (let i = 0; i < 200; i++) {
        task = (await agent.get(`/api/tasks/${batch.taskId}`).expect(200)).body.data;
        if (['succeeded', 'blocked', 'failed'].includes(task.status)) break;
        await delay(50);
      }
      expect(task).toMatchObject({ status: 'succeeded' });
      expect(quotedMaterial).toMatchObject({
        kind: 'material-text',
        materialId: materialIds[1],
        position: 1,
      });
      const items = (await agent.get(base).query(scope).expect(200)).body.data.items;
      expect(items).toHaveLength(1);
      const detail = (await agent.get(`${base}/${items[0].id}`).query(scope).expect(200)).body.data;
      expect(detail.versions[0].evidence[0]).toMatchObject({
        material: { kind: 'material-text', materialId: materialIds[1], position: 1 },
        quote: '作者写道，海边有灯塔。',
      });
    } finally {
      fixture.closeAllConnections();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  }, 35_000);

  it('删除一条分享后保留另一合法引用，删除最后一条后撤销原件访问', async () => {
    const agent = await login();
    const body = Buffer.from('独立分享的材料原文。');
    const upload = await agent
      .put('/api/materials')
      .query({
        requestId: randomUUID(),
        filename: '共享.txt',
        kind: 'text',
      })
      .set('Content-Type', 'application/octet-stream')
      .send(body)
      .expect(200);
    const id = upload.body.data.id;
    const shares = [];
    for (const name of ['阿澜', '阿溪']) {
      const companion = (
        await agent
          .post('/api/companions')
          .send({ requestId: randomUUID(), name, initialProfile: '公开材料按来源处理。' })
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
      const message = (
        await agent
          .post(`/api/chats/${chat.id}/messages`)
          .send({ requestId: randomUUID(), text: '', materialIds: [id] })
          .expect(201)
      ).body.data.message;
      shares.push({ chat, message });
    }
    for (const [index, share] of shares.entries()) {
      const conversation = (await agent.get(`/api/conversations/${share.chat.id}`).expect(200)).body
        .data.conversation;
      const operation = (
        await agent
          .post('/api/lifecycle')
          .send({
            requestId: randomUUID(),
            kind: 'delete_messages',
            conversationId: share.chat.id,
            expectedVersion: conversation.version,
            messages: [
              { messageId: share.message.id, contentVersion: share.message.contentVersion },
            ],
          })
          .expect(201)
      ).body.data;
      await agent.get(`/api/materials/${id}/original`).expect(index ? 404 : 200);
      await app.get(TaskWorkerService).start();
      let status;
      for (let i = 0; i < 150; i++) {
        status = (await agent.get(`/api/lifecycle/${operation.id}`).expect(200)).body.data;
        if (status.completedAt) break;
        await delay(45);
      }
      expect(status.completedAt).toEqual(expect.any(String));
      await app.get(TaskWorkerService).stop();
      await agent.get(`/api/materials/${id}/parts`).expect(index ? 404 : 200);
    }
    const { readdir } = await import('node:fs/promises');
    const ownerDirectory = join(dataDir, 'materials', shares[0]!.message.ownerId);
    expect(await readdir(ownerDirectory)).toEqual([]);
  }, 30_000);
});
