import { TaskWorkerService } from '../src/modules/tasks/task-worker.service';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../src/app';
import type { ServerConfig } from '../src/config';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';

// 1×1 PNG，通过公开上传入口验证完整图片处理与持久化。
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4XkAAAAASUVORK5CYII=',
  'base64',
);
describe('伴侣头像公共 HTTP 接口', () => {
  let app: INestApplication;
  let database: TestDatabase;
  let config: ServerConfig;
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    await database?.dispose();
  });
  beforeEach(async () => {
    config = {
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      qdrantUrl: process.env.TEST_QDRANT_URL ?? 'http://127.0.0.1:1',
      qdrantApiKey: process.env.TEST_QDRANT_API_KEY ?? 'test-vector-key',
      adminPassword: 'avatar-test-password',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir: await mkdtemp(join(tmpdir(), 'mw-avatar-')),
      webDistDir: null,
    };
    app = await createApplication(config);
  });
  afterEach(async () => {
    await app?.close();
    await rm(config.dataDir, { recursive: true, force: true });
  });
  async function login() {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    return agent;
  }
  it('上传、认证读取和重启保留头像，同时不改写初始人格', async () => {
    let agent = await login();
    const original = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: '星晚', initialProfile: '喜欢宁静的夜晚。' })
        .expect(201)
    ).body.data;
    const saved = (
      await agent
        .put(`/api/companions/${original.id}/avatar`)
        .query({ requestId: randomUUID(), runtimeEpoch: 1, expectedVersion: 0 })
        .set('Content-Type', 'image/png')
        .send(png)
        .expect(200)
    ).body.data;
    expect(saved).toMatchObject({
      avatarVersion: 1,
      avatar: { width: 512, height: 512, mimeType: 'image/webp' },
    });
    await request(app.getHttpServer()).get(saved.avatar.url).expect(401);
    const image = await agent
      .get(saved.avatar.url)
      .expect(200)
      .expect('Content-Type', /image\/webp/);
    expect(image.body.subarray(0, 4).toString()).toBe('RIFF');
    await app.close();
    app = await createApplication(config);
    agent = await login();
    const restored = (await agent.get(`/api/companions/${original.id}`).expect(200)).body.data;
    expect(restored.avatar).toEqual(saved.avatar);
    expect(restored.currentPersonaVersion).toEqual(original.currentPersonaVersion);
    expect(restored.initialSnapshot).toEqual(original.initialSnapshot);
    expect(restored.version).toBe(original.version);
    await agent.get(saved.avatar.url).expect(200);
  });
  it('重置保留头像，删除实例等待文件清理后才完成', async () => {
    const agent = await login();
    const companion = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: '保留头像', initialProfile: '初始人生。' })
        .expect(201)
    ).body.data;
    const saved = (
      await agent
        .put(`/api/companions/${companion.id}/avatar`)
        .query({ requestId: randomUUID(), runtimeEpoch: 1, expectedVersion: 0 })
        .set('Content-Type', 'image/png')
        .send(png)
        .expect(200)
    ).body.data;
    async function complete(kind: string, runtimeEpoch: number, expectedVersion: number) {
      const op = (
        await agent
          .post('/api/lifecycle')
          .send({
            requestId: randomUUID(),
            kind,
            companionId: companion.id,
            runtimeEpoch,
            expectedVersion,
          })
          .expect(201)
      ).body.data;
      let state = op;
      for (let i = 0; i < 200 && !state.completedAt; i++) {
        await delay(50);
        state = (await agent.get(`/api/lifecycle/${op.id}`).expect(200)).body.data;
      }
      expect(state.completedAt).toEqual(expect.any(String));
    }
    await app.get(TaskWorkerService).start();
    await complete('reset_companion', 1, 1);
    const reset = (await agent.get(`/api/companions/${companion.id}`).expect(200)).body.data;
    expect(reset.avatar).toEqual(saved.avatar);
    await agent.get(saved.avatar.url).expect(200);
    await complete('delete_companion', 2, 2);
    await agent.get(saved.avatar.url).expect(404);
    const files = await readdir(config.dataDir, { recursive: true });
    expect(files.filter((path) => path.endsWith('.webp'))).toEqual([]);
  });
  it('拒绝伪装、超限和越代上传，并发替换只采用一个版本且旧地址失效', async () => {
    const agent = await login();
    const c = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: '并发头像', initialProfile: '保留人格。' })
        .expect(201)
    ).body.data;
    const path = `/api/companions/${c.id}/avatar`;
    const input = { requestId: randomUUID(), runtimeEpoch: 1, expectedVersion: 0 };
    await request(app.getHttpServer())
      .put(path)
      .query(input)
      .set('Content-Type', 'image/png')
      .send(png)
      .expect(401);
    await agent
      .put(path)
      .query(input)
      .set('Origin', 'https://untrusted.example')
      .set('Content-Type', 'image/png')
      .send(png)
      .expect(403);
    await agent
      .put(path)
      .query(input)
      .set('Content-Type', 'image/svg+xml')
      .send('<svg/>')
      .expect(415);
    await agent
      .put(path)
      .query(input)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('<svg/>'))
      .expect(400);
    await agent
      .put(path)
      .query(input)
      .set('Content-Type', 'image/png')
      .send(Buffer.alloc(2 * 1024 * 1024 + 1))
      .expect(413);
    await agent
      .put(path)
      .query({ ...input, runtimeEpoch: 2 })
      .set('Content-Type', 'image/png')
      .send(png)
      .expect(409);
    const first = (
      await agent.put(path).query(input).set('Content-Type', 'image/png').send(png).expect(200)
    ).body.data;
    const replay = (
      await agent.put(path).query(input).set('Content-Type', 'image/png').send(png).expect(200)
    ).body.data;
    expect(replay).toEqual(first);
    const results = await Promise.all(
      [randomUUID(), randomUUID()].map((requestId) =>
        agent
          .put(path)
          .query({ requestId, runtimeEpoch: 1, expectedVersion: 1 })
          .set('Content-Type', 'image/png')
          .send(png),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const current = results.find((result) => result.status === 200)!.body.data;
    expect(current.avatarVersion).toBe(2);
    await agent.get(first.avatar.url).expect(404);
    await agent.get(current.avatar.url).expect(200);
    await agent.delete(path).send(input).expect(409);
    const cleared = (
      await agent
        .delete(path)
        .send({ ...input, expectedVersion: 2 })
        .expect(200)
    ).body.data;
    expect(cleared).toEqual({ avatar: null, avatarVersion: 3 });
    await agent.get(current.avatar.url).expect(404);
    await agent
      .delete(path)
      .send({ ...input, expectedVersion: 2 })
      .expect(200);
    await agent
      .put(path)
      .query({ ...input, expectedVersion: 0 })
      .set('Content-Type', 'image/png')
      .send(png)
      .expect(409);
    const restored = (
      await agent
        .put(path)
        .query({ ...input, expectedVersion: 3 })
        .set('Content-Type', 'image/png')
        .send(png)
        .expect(200)
    ).body.data;
    expect(restored.avatar.url).not.toBe(first.avatar.url);
    await agent.get(first.avatar.url).expect(404);
  });
  it('拒绝包含动画控制块的 PNG，不能静默丢弃动画帧', async () => {
    const agent = await login();
    const companion = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: '静态头像', initialProfile: '保留原稿。' })
        .expect(201)
    ).body.data;
    const animated = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAACGFjVEwAAAACAAAAAPONk3AAAAALSURBVHjaY/z/HwADAwIA76PheQAAAABJRU5ErkJggg==',
      'base64',
    );
    await agent
      .put(`/api/companions/${companion.id}/avatar`)
      .query({ requestId: randomUUID(), runtimeEpoch: 1, expectedVersion: 0 })
      .set('Content-Type', 'image/png')
      .send(animated)
      .expect(400);
  });
});
