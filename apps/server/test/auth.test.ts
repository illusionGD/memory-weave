import { createTestAuthConfig, disposeTestAuth } from './support/redis';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../src/app';
import type { ServerConfig } from '../src/config';
import { createRedisFaultProxy } from './support/redis-proxy';

afterAll(disposeTestAuth);

describe('single-owner HTTP access', () => {
  let app: INestApplication;
  let dataDir: string;
  let config: ServerConfig;
  let redisProxy: Awaited<ReturnType<typeof createRedisFaultProxy>> | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memory-weave-auth-'));
    config = {
      ...createTestAuthConfig(),
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
    await app?.close();
    await redisProxy?.close();
    redisProxy = undefined;
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
    expect(login.headers['set-cookie']?.[0]).toContain('Max-Age=43200');
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

  it('在两个后端进程间共享登录尝试次数', async () => {
    const second = await createApplication(config);
    try {
      for (const target of [app, second, app, second, app]) {
        await request(target.getHttpServer())
          .post('/api/auth/login')
          .send({ password: 'wrong-password' })
          .expect(401);
      }
      const limited = await request(second.getHttpServer())
        .post('/api/auth/login')
        .send({ password: config.adminPassword })
        .expect(429);
      expect(limited.headers['set-cookie']).toBeUndefined();
    } finally {
      await second.close();
    }
  });

  it('并发创建会话时仍最多保留十个并淘汰最早登录', async () => {
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const oldest = await loginFromSource(port, config.adminPassword, '127.0.0.2');
    const cookies = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        loginFromSource(port, config.adminPassword, `127.0.0.${index + 3}`),
      ),
    );
    await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', oldest).expect(401);
    for (const cookie of cookies)
      await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', cookie).expect(200);
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

  it('访问和重建应用都不延长会话的 Redis 绝对有效期', async () => {
    await app.close();
    config.authSessionLifetimeMs = 2400;
    app = await createApplication(config);
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ password: config.adminPassword })
      .expect(200);
    const cookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    await delay(1000);
    await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', cookie).expect(200);
    await app.close();
    app = await createApplication(config);
    await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', cookie).expect(200);
    await delay(1500);
    await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', cookie).expect(401);
  });

  it('多应用共享会话并同步退出，关闭一个应用不清空其他终端的登录', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ password: config.adminPassword })
      .expect(200);
    const cookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    const second = await createApplication(config);
    try {
      await request(second.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', cookie)
        .expect(200);
      const other = await request(second.getHttpServer())
        .post('/api/auth/login')
        .send({ password: config.adminPassword })
        .expect(200);
      const otherCookie = String(other.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
      await request(second.getHttpServer())
        .post('/api/auth/logout')
        .set('Cookie', cookie)
        .expect(200);
      await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', cookie).expect(401);
      await second.close();
      await request(app.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', otherCookie)
        .expect(200);
    } finally {
      await second.close();
    }
  });

  it.each(['password', 'secret'] as const)(
    '轮换 %s 后原 Cookie 失效且新登录正常',
    async (credential) => {
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ password: config.adminPassword })
        .expect(200);
      const cookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
      await app.close();
      config = {
        ...config,
        ...(credential === 'password'
          ? { adminPassword: 'new-deployment-password' }
          : { authSessionSecret: 'f'.repeat(64) }),
      };
      app = await createApplication(config);
      await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', cookie).expect(401);
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ password: config.adminPassword })
        .expect(200);
    },
  );

  it('隔离部署之间既不共享 Cookie 也不共用登录限流', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ password: config.adminPassword })
      .expect(200);
    const cookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    for (let attempt = 0; attempt < 4; attempt++)
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ password: 'wrong-password' })
        .expect(401);
    const isolated = await createApplication({ ...config, ...createTestAuthConfig() });
    try {
      await request(isolated.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', cookie)
        .expect(401);
      await request(isolated.getHttpServer())
        .post('/api/auth/login')
        .send({ password: config.adminPassword })
        .expect(200);
    } finally {
      await isolated.close();
    }
  });

  it('Redis 断线返回可识别的 503 且不清 Cookie，恢复后原会话仍有效', async () => {
    await app.close();
    redisProxy = await createRedisFaultProxy(config.redisUrl);
    app = await createApplication({ ...config, redisUrl: redisProxy.url });
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ password: config.adminPassword })
      .expect(200);
    const cookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    redisProxy.disconnect();
    for (const [method, path] of [
      ['get', '/api/auth/session'],
      ['post', '/api/auth/logout'],
      ['post', '/api/auth/login'],
    ] as const) {
      const response = await request(app.getHttpServer())
        [method](path)
        .set('Cookie', cookie)
        .send(
          method === 'post' && path.endsWith('login')
            ? { password: config.adminPassword }
            : undefined,
        )
        .expect(503);
      expect(response.body).toEqual({
        code: 50303,
        data: null,
        message: '认证服务暂时不可用，请稍后重试。',
      });
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    await request(app.getHttpServer()).get('/api/health/live').expect(200);
    await request(app.getHttpServer()).get('/api/health/ready').expect(503);
    redisProxy.reconnect();
    await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', cookie).expect(200);
  });

  it('Redis 接受连接却不响应握手时在有限时间内返回 503', async () => {
    await app.close();
    redisProxy = await createRedisFaultProxy(config.redisUrl);
    redisProxy.stall();
    app = await createApplication({ ...config, redisUrl: redisProxy.url });
    const started = performance.now();
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ password: config.adminPassword })
      .expect(503);
    expect(response.body.code).toBe(50303);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(4000);
    redisProxy.reconnect();
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ password: config.adminPassword })
      .expect(200);
  });

  it('保留后端重启前尚未到期的登录会话', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ password: config.adminPassword })
      .expect(200);
    const cookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    await app.close();
    app = await createApplication(config);
    await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', cookie).expect(200);
  });
});

/**
 * 使用真实回环来源发起登录，独立验证会话上限而不绕过来源限流。
 * @param port 测试应用监听端口。
 * @param password 当前部署的测试登录密码。
 * @param source 绑定到本次 TCP 请求的真实回环地址。
 * @returns 登录响应中的会话 Cookie。
 */
async function loginFromSource(port: number, password: string, source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ password });
    const login = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/api/auth/login',
        method: 'POST',
        localAddress: source,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (response) => {
        response.resume();
        response.on('end', () => {
          if (response.statusCode !== 200)
            return reject(new Error(`登录 HTTP ${response.statusCode}`));
          resolve(String(response.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '');
        });
      },
    );
    login.on('error', reject);
    login.end(body);
  });
}
