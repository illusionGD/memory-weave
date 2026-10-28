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

describe('人设模板的公开 HTTP 契约', () => {
  let app: INestApplication;
  let config: ServerConfig;
  let database: TestDatabase;
  let dataDir: string;

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
    await database?.dispose();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  async function login() {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    return agent;
  }

  it('创建模板幂等且持久，查询不创建伴侣或发起模型调用', async () => {
    await request(app.getHttpServer()).get('/api/persona-templates').expect(401);
    let agent = await login();
    const input = {
      requestId: randomUUID(),
      name: '旅行记录者',
      initialProfile: '小夜喜欢文学，起初慢热，希望她始终保留直率和独立思考。',
      lockedFeatures: ['保持独立思考'],
    };
    const created = (await agent.post('/api/persona-templates').send(input).expect(201)).body.data;
    expect(created).toMatchObject({
      version: 1,
      name: input.name,
      initialProfile: input.initialProfile,
      lockedFeatures: input.lockedFeatures,
    });
    expect((await agent.post('/api/persona-templates').send(input).expect(201)).body.data).toEqual(
      created,
    );
    expect(
      (
        await agent
          .post('/api/persona-templates')
          .send({ ...input, name: '另一个模板' })
          .expect(409)
      ).body.code,
    ).toBe(40901);
    await app.close();
    app = await createApplication(config);
    agent = await login();
    expect((await agent.get(`/api/persona-templates/${created.id}`).expect(200)).body.data).toEqual(
      created,
    );
    expect((await agent.get('/api/persona-templates').expect(200)).body.data.items).toEqual([
      created,
    ]);
    expect((await agent.get('/api/companions')).body.data.items).toEqual([]);
    expect((await agent.get('/api/models/usage')).body.data.global.charged.requests).toBe(0);
  });

  it('模板更新追加版本，并发旧版本更新冲突；历史仍可精确复用', async () => {
    const agent = await login();
    const first = (
      await agent
        .post('/api/persona-templates')
        .send({
          requestId: randomUUID(),
          name: '夜',
          initialProfile: '喜欢文学',
          lockedFeatures: [],
        })
        .expect(201)
    ).body.data;
    const update = {
      requestId: randomUUID(),
      expectedVersion: 1,
      name: '夜的新版',
      initialProfile: '喜欢文学与旅行',
      lockedFeatures: ['保留独立思考'],
    };
    const second = (
      await agent.post(`/api/persona-templates/${first.id}/versions`).send(update).expect(201)
    ).body.data;
    expect(second).toMatchObject({
      id: first.id,
      version: 2,
      initialProfile: update.initialProfile,
    });
    expect(
      (await agent.post(`/api/persona-templates/${first.id}/versions`).send(update).expect(201))
        .body.data,
    ).toEqual(second);
    await agent
      .post(`/api/persona-templates/${first.id}/versions`)
      .send({ ...update, requestId: randomUUID() })
      .expect(409);
    expect(
      (await agent.get(`/api/persona-templates/${first.id}/versions/1`).expect(200)).body.data,
    ).toEqual(first);
    expect((await agent.get(`/api/persona-templates/${first.id}`).expect(200)).body.data).toEqual(
      second,
    );
    await agent.get(`/api/persona-templates/${randomUUID()}`).expect(404);
    await agent.get(`/api/persona-templates/${first.id}/versions/3`).expect(404);
    await agent
      .post('/api/persona-templates')
      .send({ requestId: randomUUID(), name: '坏模板', initialProfile: '   ' })
      .expect(400);
  });

  it('完整保留带空白的中文原稿，较长的合法原稿和明确约束可一起保存', async () => {
    const agent = await login();
    const input = {
      requestId: randomUUID(),
      name: '长原稿',
      initialProfile: `  ${'喜欢文学。'.repeat(700)}\n`,
      lockedFeatures: Array.from({ length: 20 }, (_, i) => `${i}保留${'独立思考'.repeat(60)}`),
    };
    const created = (await agent.post('/api/persona-templates').send(input).expect(201)).body.data;
    expect(created.initialProfile).toBe(input.initialProfile);
    expect(created.lockedFeatures).toEqual(input.lockedFeatures);
  });
});
