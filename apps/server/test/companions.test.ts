import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { companionListResponseSchema } from '@memory-weave/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../src/app';
import type { ServerConfig } from '../src/config';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';
import { expectApiError } from './support/http';

describe('部署管理者通过 HTTP 管理伴侣实例', () => {
  let app: INestApplication;
  let dataDir: string;
  let config: ServerConfig;
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.dispose();
  });

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memory-weave-companions-'));
    config = {
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      adminPassword: 'test-password-for-companions',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir,
      webDistDir: null,
    };
    app = await createApplication(config);
  });

  afterEach(async () => {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('登录后可读取部署身份，并创建和回查分开保存的初始快照与当前人格', async () => {
    await request(app.getHttpServer()).get('/api/workspace').expect(401);
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    const workspace = await agent.get('/api/workspace').expect(200);
    expect(workspace.body).toEqual({
      ownerId: expect.any(String),
      schemaVersion: 1,
      displayName: '用户',
    });
    const created = await agent
      .post('/api/companions')
      .send({
        requestId: randomUUID(),
        name: '初始伴侣',
        initialProfile: '我喜欢一起看星星。\n保留未经模型处理的原始设定。',
      })
      .expect(201);
    expect(created.body).toMatchObject({
      ownerId: workspace.body.ownerId,
      name: '初始伴侣',
      runtimeEpoch: 1,
      version: 1,
      initialSnapshot: {
        schemaVersion: 1,
        sourceKind: 'initial_setting',
        profileText: '我喜欢一起看星星。\n保留未经模型处理的原始设定。',
      },
      currentPersonaVersion: {
        ownerId: workspace.body.ownerId,
        runtimeEpoch: 1,
        version: 1,
        profileText: '我喜欢一起看星星。\n保留未经模型处理的原始设定。',
      },
    });
    expect(created.body.initialSnapshot.id).not.toBe(created.body.currentPersonaVersionId);
    expect(created.body.currentPersonaVersion.id).toBe(created.body.currentPersonaVersionId);
    expect(created.body.currentPersonaVersion.companionId).toBe(created.body.id);
    await agent.get(`/api/companions/${created.body.id}`).expect(200, created.body);
  });

  it('同一创建命令并发重试复用实例，改用其他内容返回冲突且不覆盖原文', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    const command = {
      requestId: randomUUID(),
      name: '并发创建的伴侣',
      initialProfile: '第一次提交的初始原文。',
    };
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => agent.post('/api/companions').send(command)),
    );
    for (const response of responses) {
      expect(response.status).toBe(201);
      expect(response.body).toEqual(responses[0]!.body);
    }
    await agent
      .post('/api/companions')
      .send({ ...command, requestId: command.requestId.toUpperCase() })
      .expect(201, responses[0]!.body);
    const conflict = await agent
      .post('/api/companions')
      .send({ ...command, initialProfile: '不能覆盖最初创建的原文。' })
      .expect(409);
    expectApiError(conflict, 409, 'IDEMPOTENCY_CONFLICT');
    expect(conflict.body.requestId).not.toBe(command.requestId);
    expect(new Set(responses.map((response) => response.headers['x-request-id'])).size).toBe(4);
    await agent.get(`/api/companions/${responses[0]!.body.id}`).expect(200, responses[0]!.body);
  });

  it('以稳定实例标识分页遍历，每个实例只返回一次且游标只在有下一页时出现', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    const createdIds: string[] = [];
    for (const name of ['分页伴侣甲', '分页伴侣乙', '分页伴侣丙']) {
      const created = await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name, initialProfile: '保留各自的稳定身份。' })
        .expect(201);
      createdIds.push(created.body.id);
    }
    const seenIds: string[] = [];
    let afterId: string | null = null;
    do {
      const response = await agent
        .get('/api/companions')
        .query({ limit: 2, ...(afterId ? { afterId } : {}) })
        .expect(200);
      const page = companionListResponseSchema.parse(response.body);
      expect(page.items.length).toBeLessThanOrEqual(2);
      if (page.nextAfterId) {
        expect(page.items).toHaveLength(2);
        expect(page.nextAfterId).toBe(page.items.at(-1)!.id);
      }
      for (const item of page.items) {
        expect(seenIds).not.toContain(item.id);
        seenIds.push(item.id);
      }
      afterId = page.nextAfterId;
    } while (afterId);
    expect(seenIds).toEqual([...seenIds].sort());
    expect(seenIds).toEqual(expect.arrayContaining(createdIds));
    const exhausted = await agent
      .get('/api/companions')
      .query({ afterId: seenIds.at(-1), limit: 2 })
      .expect(200);
    expect(exhausted.body).toEqual({ items: [], nextAfterId: null });
  });

  it('服务重启后部署身份、实例和幂等结果仍保留，重新登录即可继续回查', async () => {
    let agent = request.agent(app.getHttpServer());
    const login = await agent
      .post('/api/auth/login')
      .send({ password: config.adminPassword })
      .expect(200);
    const oldCookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
    const workspace = await agent.get('/api/workspace').expect(200);
    const command = {
      requestId: randomUUID(),
      name: '重启后保留的伴侣',
      initialProfile: '  初始空白也应原样保存。\n',
    };
    const created = await agent.post('/api/companions').send(command).expect(201);
    await app.close();
    app = await createApplication(config);
    await request(app.getHttpServer()).get('/api/workspace').set('Cookie', oldCookie).expect(401);
    agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    await agent.get('/api/workspace').expect(200, workspace.body);
    await agent.get(`/api/companions/${created.body.id}`).expect(200, created.body);
    await agent.post('/api/companions').send(command).expect(201, created.body);
    expect(created.body.initialSnapshot.profileText).toBe('  初始空白也应原样保存。\n');
  });

  it('拒绝由请求指定归属、代次及非法字段，不存在的实例返回不可见结果', async () => {
    await request(app.getHttpServer()).get('/api/companions').expect(401);
    await request(app.getHttpServer()).post('/api/companions').send({}).expect(401);
    await request(app.getHttpServer()).get(`/api/companions/${randomUUID()}`).expect(401);
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    const command = { requestId: randomUUID(), name: '边界伴侣', initialProfile: '最初设定。' };
    for (const invalid of [
      { ...command, ownerId: randomUUID() },
      { ...command, runtimeEpoch: 2 },
      { ...command, name: ' ' },
      { ...command, name: '长'.repeat(81) },
      { ...command, initialProfile: '' },
      { ...command, initialProfile: '长'.repeat(4001) },
      { ...command, requestId: '不是 UUID' },
    ]) {
      await agent.post('/api/companions').send(invalid).expect(400);
    }
    for (const query of [
      { limit: 0 },
      { limit: 101 },
      { limit: '1.5' },
      { limit: '1e2' },
      { afterId: '不是 UUID' },
      { ownerId: randomUUID() },
    ]) {
      await agent.get('/api/companions').query(query).expect(400);
    }
    await agent.get('/api/companions/不是UUID').expect(400);
    const missing = await agent.get(`/api/companions/${randomUUID()}`).expect(404);
    expectApiError(missing, 404, 'RESOURCE_NOT_FOUND');
    const created = await agent.post('/api/companions').send(command).expect(201);
    const workspace = await agent.get('/api/workspace').expect(200);
    expect(created.body.ownerId).toBe(workspace.body.ownerId);
    expect(created.body.runtimeEpoch).toBe(1);
    expect(created.body).not.toHaveProperty('requestId');
    expect(created.body).not.toHaveProperty('fingerprint');
  });

  it('相同设定可创建身份独立的实例，列表默认只取二十条', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    const before = companionListResponseSchema.parse(
      (await agent.get('/api/companions').query({ limit: 100 }).expect(200)).body,
    );
    const ids: string[] = [];
    const snapshots: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const created = await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: '同名的独立实例', initialProfile: '相同设定。' })
        .expect(201);
      expect(created.body.runtimeEpoch).toBe(1);
      ids.push(created.body.id);
      snapshots.push(created.body.initialSnapshot.id);
    }
    expect(new Set(ids).size).toBe(21);
    expect(new Set(snapshots).size).toBe(21);
    const first = companionListResponseSchema.parse(
      (await agent.get('/api/companions').expect(200)).body,
    );
    expect(first.items).toHaveLength(20);
    expect(first.items.map((item) => item.id)).toEqual(
      [...before.items.map((item) => item.id), ...ids].sort().slice(0, 20),
    );
    expect(first.nextAfterId).toBe(first.items[19]!.id);
  });

  it('数据服务不可用时返回脱敏的503，同时保持HTTP进程存活', async () => {
    await app.close();
    app = await createApplication({
      ...config,
      databaseUrl: 'postgres://private:must-not-appear@127.0.0.1:1/unavailable',
    });
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    for (const path of ['/api/workspace', '/api/companions', `/api/companions/${randomUUID()}`]) {
      const response = await agent.get(path).expect(503);
      expect(JSON.stringify(response.body)).not.toContain('must-not-appear');
      expect(JSON.stringify(response.body)).not.toContain('postgres://');
    }
    await agent
      .post('/api/companions')
      .send({ requestId: randomUUID(), name: '暂时无法创建', initialProfile: '等待数据服务恢复。' })
      .expect(503);
    await request(app.getHttpServer()).get('/api/health/live').expect(200);
  });
});
