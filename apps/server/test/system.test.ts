import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../src/app';
import type { ServerConfig } from '../src/config';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';
import { expectApiError, expectApiSuccess } from './support/http';
import { runMigrations } from '../src/database/migrations';

describe('observable service health', () => {
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
    dataDir = await mkdtemp(join(tmpdir(), 'memory-weave-system-'));
    config = {
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
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
    expect(response.body.data).toEqual({ status: 'ok' });
  });

  it('reports the real PostgreSQL vector extension and writable storage to the signed-in owner', async () => {
    const anonymous = await request(app.getHttpServer()).get('/api/system/status');
    expect(anonymous.status).toBe(401);
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    const status = await agent.get('/api/system/status');
    expect(status.status).toBe(200);
    expect(status.body.data).toEqual({
      service: 'memory-weave',
      version: '0.1.0',
      stage: 'foundation',
      database: { status: 'connected', vectorVersion: expect.stringMatching(/^0\.8\./) },
      storage: { status: 'ready' },
      schema: { status: 'ready', version: expect.any(String) },
    });
    expect(JSON.stringify(status.body).includes(config.databaseUrl)).toBe(false);
    expect(JSON.stringify(status.body).includes(config.adminPassword)).toBe(false);
    await request(app.getHttpServer())
      .get('/api/health/ready')
      .expect(200)
      .expect((response) => expectApiSuccess(response, { status: 'ok' }));
  });

  it('keeps an unmigrated F01 database live but not ready, then recovers after migration', async () => {
    const legacy = await createTestDatabase({ migrate: false });
    const client = new Client({ connectionString: legacy.databaseUrl });
    let legacyApp: INestApplication | undefined;
    try {
      await client.connect();
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.end();
      legacyApp = await createApplication({ ...config, databaseUrl: legacy.databaseUrl });
      const agent = request.agent(legacyApp.getHttpServer());
      await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
      const status = await agent.get('/api/system/status').expect(200);
      expect(status.body.data.database.status).toBe('connected');
      expect(status.body.data.schema).toEqual({ status: 'pending', version: null });
      await request(legacyApp.getHttpServer()).get('/api/health/live').expect(200);
      await request(legacyApp.getHttpServer()).get('/api/health/ready').expect(503);
      const unavailable = await agent.get('/api/workspace').expect(503);
      expectApiError(unavailable, 503, 50301);
      await runMigrations(legacy.databaseUrl);
      await request(legacyApp.getHttpServer()).get('/api/health/ready').expect(200);
      await agent.get('/api/workspace').expect(200);
    } finally {
      await client.end().catch(() => undefined);
      await legacyApp?.close();
      await legacy.dispose();
    }
  });

  it('reports database unavailability without crashing the HTTP process or disclosing credentials', async () => {
    await app.close();
    app = await createApplication({
      ...config,
      databaseUrl: 'postgres://private:do-not-echo@127.0.0.1:1/unavailable',
    });
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    const status = await agent.get('/api/system/status').expect(200);
    expect(status.body.data.database).toEqual({ status: 'unavailable', vectorVersion: null });
    expect(JSON.stringify(status.body)).not.toContain('do-not-echo');
    const notReady = await request(app.getHttpServer()).get('/api/health/ready').expect(503);
    expectApiError(notReady, 503, 50302);
    await request(app.getHttpServer()).get('/api/health/live').expect(200);
  });
});
