import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../src/app';
import { expectApiError } from './support/http';

describe('production web delivery', () => {
  let app: INestApplication;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'memory-weave-web-'));
    await mkdir(join(directory, 'chat'));
    await mkdir(join(directory, 'admin'));
    await writeFile(
      join(directory, 'chat', 'index.html'),
      '<!doctype html><title>Memory Weave fixture</title>',
    );
    await writeFile(
      join(directory, 'admin', 'index.html'),
      '<!doctype html><title>Admin console fixture</title>',
    );
    app = await createApplication({
      qdrantUrl: process.env.TEST_QDRANT_URL ?? 'http://127.0.0.1:1',
      qdrantApiKey: process.env.TEST_QDRANT_API_KEY ?? 'test-vector-key',
      host: '127.0.0.1',
      port: 0,
      databaseUrl: 'mysql://unused:unused@127.0.0.1:1/unused',
      adminPassword: 'test-password-for-foundation',
      appOrigin: 'http://localhost:3000',
      cookieSecure: false,
      dataDir: join(directory, 'data'),
      webDistDir: join(directory, 'chat'),
      adminDistDir: join(directory, 'admin'),
    });
  });

  afterEach(async () => {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('serves the compiled web entry for browser routes', async () => {
    const response = await request(app.getHttpServer()).get('/status').set('Accept', 'text/html');
    expect(response.status).toBe(200);
    expect(response.text).toContain('Memory Weave fixture');
  });
  it('管理子路径只返回独立管理构建，聊天路由和缺失资源不串到另一端', async () => {
    const admin = await request(app.getHttpServer())
      .get('/admin/companions')
      .set('Accept', 'text/html')
      .expect(200);
    expect(admin.text).toContain('Admin console fixture');
    expect(admin.text).not.toContain('Memory Weave fixture');
    const chat = await request(app.getHttpServer())
      .get('/chats/example')
      .set('Accept', 'text/html')
      .expect(200);
    expect(chat.text).toContain('Memory Weave fixture');
    expect(chat.text).not.toContain('Admin console fixture');
    await request(app.getHttpServer()).get('/admin/missing.js').expect(404);
  });

  it('keeps an HTTP review deployment from upgrading its assets to HTTPS', async () => {
    const response = await request(app.getHttpServer()).get('/').set('Accept', 'text/html');
    expect(response.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it.each(['/api/missing', '/API/missing'])(
    'does not turn the API path %s into a successful SPA response',
    async (path) => {
      const response = await request(app.getHttpServer()).get(path).set('Accept', 'text/html');
      expect(response.status).toBe(404);
      expect(response.type).toBe('application/json');
      expectApiError(response, 404, 404);
    },
  );

  it('returns missing static assets as errors instead of HTML', async () => {
    const response = await request(app.getHttpServer()).get('/missing.js');
    expect(response.status).toBe(404);
    expect(response.text).not.toContain('Memory Weave fixture');
  });
});
