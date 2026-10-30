import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app';
import type { ServerConfig } from '../src/config';

describe('single-owner HTTP access', () => {
  let app: INestApplication;
  let dataDir: string;
  let config: ServerConfig;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memory-weave-auth-'));
    config = {
      qdrantUrl: process.env.TEST_QDRANT_URL ?? 'http://127.0.0.1:1',
      qdrantApiKey: process.env.TEST_QDRANT_API_KEY ?? 'test-vector-key',
      host: '127.0.0.1',
      port: 0,
      databaseUrl: process.env.TEST_DATABASE_URL ?? 'mysql://unused:unused@127.0.0.1:1/unused',
      adminPassword: 'test-password-for-foundation',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir,
      webDistDir: null,
    };
    app = await createApplication(config);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('requires authentication before returning the current session', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/auth/session')
      .set('X-Request-Id', 'client-provided-value');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      code: 401,
      message: '请登录后继续。',
      data: null,
    });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('signs in with the configured password and reuses an HttpOnly session cookie', async () => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post('/api/auth/login')
      .send({ password: 'test-password-for-foundation' });
    expect(login.status).toBe(200);
    expect(login.body).toEqual({
      code: 200,
      data: { authenticated: true },
      message: '操作成功。',
    });
    expect(login.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(login.headers['set-cookie']).toEqual([
      expect.stringMatching(/memory_weave_session=.*HttpOnly.*SameSite=Strict/),
    ]);
    const session = await agent.get('/api/auth/session');
    expect(session.status).toBe(200);
    expect(session.body).toEqual({
      code: 200,
      data: { authenticated: true },
      message: '操作成功。',
    });
    expect(session.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.headers['x-request-id']).not.toBe(login.headers['x-request-id']);
  });

  it('revokes the server session on logout, including replay of the previous cookie', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ password: 'test-password-for-foundation' });
    const cookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    const logout = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Cookie', cookie);
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ code: 200, data: null, message: '操作成功。' });
    expect(logout.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const replay = await request(app.getHttpServer())
      .get('/api/auth/session')
      .set('Cookie', cookie);
    expect(replay.status).toBe(401);
  });

  it('refuses a login sent from another browser origin', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', 'https://unrelated.example')
      .send({ password: 'test-password-for-foundation' });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      code: 40301,
      message: '请求来源不被允许。',
      data: null,
    });
    expect(response.headers['set-cookie']).toBeUndefined();
  });
  it('允许显式配置的独立管理来源，同时拒绝未登记端口和第三方来源', async () => {
    await app.close();
    app = await createApplication({ ...config, adminAppOrigin: 'http://localhost:5174' });
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:5174')
      .send({ password: config.adminPassword })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', config.appOrigin)
      .send({ password: config.adminPassword })
      .expect(200);
    for (const origin of ['http://localhost:5175', 'https://unrelated.example']) {
      const response = await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('Origin', origin)
        .send({ password: config.adminPassword })
        .expect(403);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  });

  it('applies the origin check to mixed-case API routes too', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/auth/login')
      .send({ password: 'test-password-for-foundation' })
      .expect(200);
    const response = await agent
      .post('/API/auth/logout')
      .set('Origin', 'https://unrelated.example');
    expect(response.status).toBe(403);
    await agent.get('/api/auth/session').expect(200);
  });

  it('temporarily limits repeated login attempts without creating a session', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failure = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ password: 'wrong-password' });
      expect(failure.status).toBe(401);
    }
    const limited = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ password: 'wrong-password' });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe(429);
    expect(limited.headers['set-cookie']).toBeUndefined();
  });

  it('rejects oversized JSON before attempting password verification', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ password: 'x'.repeat(20_000) });
    expect(response.status).toBe(413);
    expect(response.body.code).toBe(413);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('does not echo malformed credential content in parser errors', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('PRIVATE');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      code: 40001,
      message: '请求正文不是有效的 JSON。',
      data: null,
    });
  });

  it('rejects malformed login fields without creating a session', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ password: 12345 });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe(400);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('returns a distinct error for incorrect credentials without echoing the password', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ password: 'private-wrong-password' })
      .expect(401);
    expect(response.body).toEqual({
      code: 40101,
      message: '密码不正确，请重试。',
      data: null,
    });
  });

  it('normalizes unsupported body encodings without exposing parser errors', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Content-Type', 'application/json; charset=not-supported')
      .send('{"password":"private"}')
      .expect(415);
    expect(response.body).toEqual({
      code: 415,
      message: '请求内容格式或编码不受支持。',
      data: null,
    });
  });

  it('rejects a session after its twelve-hour lifetime', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ password: config.adminPassword })
      .expect(200);
    const cookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    const later = Date.now() + 13 * 60 * 60 * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', cookie).expect(401);
  });

  it('requires signing in again after the server restarts', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ password: config.adminPassword })
      .expect(200);
    const cookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    await app.close();
    app = await createApplication(config);
    await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', cookie).expect(401);
  });
});
