import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';

describe('observable service health', () => {
  let app: INestApplication;
  let dataDir: string;
  let config: ServerConfig;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memory-weave-system-'));
    config = {
      host: '127.0.0.1',
      port: 0,
      databaseUrl: process.env.TEST_DATABASE_URL ?? 'postgres://unused:unused@127.0.0.1:1/unused',
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
    await rm(dataDir, { recursive: true, force: true });
  });

  it('reports public liveness without disclosing deployment settings', async () => {
    const response = await request(app.getHttpServer()).get('/api/health/live');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'reports the real PostgreSQL vector extension and writable storage to the signed-in owner',
    async () => {
      const anonymous = await request(app.getHttpServer()).get('/api/system/status');
      expect(anonymous.status).toBe(401);
      const agent = request.agent(app.getHttpServer());
      await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
      const status = await agent.get('/api/system/status');
      expect(status.status).toBe(200);
      expect(status.body).toEqual({
        service: 'memory-weave',
        version: '0.1.0',
        stage: 'foundation',
        database: { status: 'connected', vectorVersion: expect.stringMatching(/^0\.8\./) },
        storage: { status: 'ready' },
      });
      expect(JSON.stringify(status.body).includes(config.databaseUrl)).toBe(false);
      expect(JSON.stringify(status.body).includes(config.adminPassword)).toBe(false);
      await request(app.getHttpServer()).get('/api/health/ready').expect(200, { status: 'ok' });
    },
  );

  it('reports database unavailability without crashing the HTTP process or disclosing credentials', async () => {
    await app.close();
    app = await createApplication({
      ...config,
      databaseUrl: 'postgres://private:do-not-echo@127.0.0.1:1/unavailable',
    });
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    const status = await agent.get('/api/system/status').expect(200);
    expect(status.body.database).toEqual({ status: 'unavailable', vectorVersion: null });
    expect(JSON.stringify(status.body)).not.toContain('do-not-echo');
    await request(app.getHttpServer()).get('/api/health/ready').expect(503);
    await request(app.getHttpServer()).get('/api/health/live').expect(200);
  });
});
