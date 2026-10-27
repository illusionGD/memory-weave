import { expectApiSuccess } from './support/http';
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

describe('部署管理者通过 HTTP 维护显示名称', () => {
  let app: INestApplication;
  let database: TestDatabase;
  let dataDir: string;
  let config: ServerConfig;

  beforeEach(async () => {
    database = await createTestDatabase();
    dataDir = await mkdtemp(join(tmpdir(), 'memory-weave-workspace-'));
    config = {
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      adminPassword: 'test-password-for-workspace',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir,
      webDistDir: null,
    };
    app = await createApplication(config);
  });

  afterEach(async () => {
    await app?.close();
    await database?.dispose();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('登录后可查询默认显示名及稳定的部署身份', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    const response = await agent.get('/api/workspace').expect(200);
    expect(response.body.data).toEqual({
      ownerId: expect.any(String),
      schemaVersion: 1,
      displayName: '用户',
    });
  });

  it('修改显示名时去除首尾空白，重复保存仍使用同一个部署身份', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    const before = await agent.get('/api/workspace').expect(200);
    const saved = await agent.patch('/api/workspace').send({ displayName: '  小林  ' }).expect(200);
    expect(saved.body.data).toEqual({ ...before.body.data, displayName: '小林' });
    await agent
      .get('/api/workspace')
      .expect(200)
      .expect((response) => expectApiSuccess(response, saved.body.data));
    await agent
      .patch('/api/workspace')
      .send({ displayName: '小林' })
      .expect(200)
      .expect((response) => expectApiSuccess(response, saved.body.data));
  });

  it('拒绝未登录、跨站及非法资料写入，错误请求不能改变既有名称', async () => {
    await request(app.getHttpServer()).get('/api/workspace').expect(401);
    await request(app.getHttpServer())
      .patch('/api/workspace')
      .send({ displayName: '未登录改名' })
      .expect(401);
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    const before = await agent.get('/api/workspace').expect(200);
    await agent
      .patch('/api/workspace')
      .set('Origin', 'https://untrusted.example')
      .send({ displayName: '跨站改名' })
      .expect(403);
    for (const body of [
      {},
      { displayName: '' },
      { displayName: ' \t\n ' },
      { displayName: '名'.repeat(81) },
      { displayName: null },
      { displayName: 42 },
      { displayName: '注入身份', ownerId: randomUUID() },
      { displayName: '注入版本', schemaVersion: 2 },
    ]) {
      await agent.patch('/api/workspace').send(body).expect(400);
    }
    await agent
      .get('/api/workspace')
      .expect(200)
      .expect((response) => expectApiSuccess(response, before.body.data));
    await agent
      .patch('/api/workspace')
      .send({ displayName: '名'.repeat(80) })
      .expect(200)
      .expect((response) =>
        expectApiSuccess(response, { ...before.body.data, displayName: '名'.repeat(80) }),
      );
  });

  it('改名及服务重启后保留资料，既有消息、会话成员和伴侣身份不被改写', async () => {
    let agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    const workspace = await agent.get('/api/workspace').expect(200);
    const companion = await agent
      .post('/api/companions')
      .send({ requestId: randomUUID(), name: '旧会话伴侣', initialProfile: '保留最初的设定。' })
      .expect(201);
    const conversation = await agent
      .post('/api/conversations')
      .send({
        requestId: randomUUID(),
        kind: 'private',
        title: '改名前建立的会话',
        includeUser: true,
        companions: [{ companionId: companion.body.data.id, runtimeEpoch: 1 }],
      })
      .expect(201);
    const conversationId = conversation.body.data.conversation.id as string;
    const draft = await agent
      .post(`/api/conversations/${conversationId}/messages`)
      .send({
        requestId: randomUUID(),
        speaker: { kind: 'user' },
        expectedConversationVersion: 1,
        text: '当时我使用“用户”这个显示名称。',
      })
      .expect(201);
    const published = await agent
      .post(`/api/conversations/${conversationId}/messages/${draft.body.data.id}/publish`)
      .send({ requestId: randomUUID(), expectedRevision: 1, expectedConversationVersion: 1 })
      .expect(201);
    expect(published.body.data.speaker).toEqual({
      kind: 'user',
      userId: workspace.body.data.ownerId,
    });
    const previousConversation = await agent
      .get(`/api/conversations/${conversationId}`)
      .expect(200);
    const saved = await agent
      .patch('/api/workspace')
      .send({ displayName: '现在的小林' })
      .expect(200);
    expect(saved.body.data).toEqual({ ...workspace.body.data, displayName: '现在的小林' });
    await agent
      .get(`/api/conversations/${conversationId}/messages/${published.body.data.id}`)
      .expect(200)
      .expect((response) => expectApiSuccess(response, published.body.data));
    await agent
      .get(`/api/conversations/${conversationId}`)
      .expect(200)
      .expect((response) => expectApiSuccess(response, previousConversation.body.data));
    await agent
      .get(`/api/companions/${companion.body.data.id}`)
      .expect(200)
      .expect((response) => expectApiSuccess(response, companion.body.data));

    await app.close();
    app = await createApplication(config);
    agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    await agent
      .get('/api/workspace')
      .expect(200)
      .expect((response) => expectApiSuccess(response, saved.body.data));
    await agent
      .get(`/api/conversations/${conversationId}/messages/${published.body.data.id}`)
      .expect(200)
      .expect((response) => expectApiSuccess(response, published.body.data));
    await agent
      .get(`/api/conversations/${conversationId}`)
      .expect(200)
      .expect((response) => expectApiSuccess(response, previousConversation.body.data));
  });
});
