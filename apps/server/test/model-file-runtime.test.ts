import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { afterAll, expect, it } from 'vitest';
import { loadServerConfig } from '../src/config';
import { createApplication } from '../src/app';
import { defaultModelConfiguration } from '../src/modules/models/model-defaults';
import { defaultModelHardLimits } from '../src/modules/models/model-deployment';
import { createTestDatabase } from './support/database';
import { createTestAuthConfig, disposeTestAuth, testAuthEnvironment } from './support/redis';

afterAll(disposeTestAuth);
it('JSON 在启动时生效，拒绝 HTTP 改写；重启保留快照、登录与用量，改文件追加一次', async () => {
  const database = await createTestDatabase();
  const directory = await mkdtemp(join(tmpdir(), 'mw-model-runtime-'));
  const file = join(directory, 'models.json');
  const document = {
    providers: [],
    hardLimits: defaultModelHardLimits(),
    configuration: defaultModelConfiguration(),
  };
  const auth = createTestAuthConfig();
  const environment = {
    ...testAuthEnvironment(auth),
    MODEL_CONFIG_FILE: file,
    DATABASE_URL: database.databaseUrl,
    ADMIN_PASSWORD: 'json-model-test-password',
    DATA_DIR: directory,
    QDRANT_URL: process.env.TEST_QDRANT_URL,
    QDRANT_API_KEY: process.env.TEST_QDRANT_API_KEY,
  };
  let app: INestApplication | undefined;
  try {
    await writeFile(file, JSON.stringify(document));
    app = await createApplication(loadServerConfig(environment));
    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post('/api/auth/login')
      .send({ password: environment.ADMIN_PASSWORD })
      .expect(200);
    const cookie = String(login.headers['set-cookie']?.[0]).split(';')[0]!;
    const first = (await agent.get('/api/models/config').expect(200)).body.data;
    expect(first.source).toBe('deployment');
    await agent
      .put('/api/models/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: first.version,
        config: first.config,
        evaluationNote: '不可写入',
      })
      .expect(409);
    await agent
      .post('/api/models/probes')
      .send({
        requestId: randomUUID(),
        expectedConfigVersion: first.version,
        role: 'embedding',
        operation: 'embedding',
        inputText: '测试向量计量',
      })
      .expect(201);
    const usage = (await agent.get('/api/models/usage').expect(200)).body.data;
    expect(usage.global.charged.requests).toBe(1);
    await app.close();
    app = await createApplication(loadServerConfig(environment));
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/models/config')
          .set('Cookie', cookie)
          .expect(200)
      ).body.data,
    ).toEqual(first);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/models/usage')
          .set('Cookie', cookie)
          .expect(200)
      ).body.data,
    ).toEqual(usage);
    document.configuration.tasks.chat.maxOutputTokens = 900;
    await writeFile(file, JSON.stringify(document));
    expect(
      (await request(app.getHttpServer()).get('/api/models/config').set('Cookie', cookie)).body
        .data,
    ).toEqual(first);
    await app.close();
    app = await createApplication(loadServerConfig(environment));
    const next = (
      await request(app.getHttpServer()).get('/api/models/config').set('Cookie', cookie).expect(200)
    ).body.data;
    expect(next.version).toBe(first.version + 1);
    expect(next.config.tasks.chat.maxOutputTokens).toBe(900);
    expect(
      (
        await request(app.getHttpServer())
          .get(`/api/models/config/versions/${first.version}`)
          .set('Cookie', cookie)
          .expect(200)
      ).body.data,
    ).toEqual(first);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/models/usage')
          .set('Cookie', cookie)
          .expect(200)
      ).body.data.global,
    ).toEqual(usage.global);
  } finally {
    await app?.close();
    await database.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
