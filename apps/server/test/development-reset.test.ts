import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, expect, it } from 'vitest';
import { createClient } from 'redis';
import { createApplication } from '../src/app';
import { createTestDatabase } from './support/database';
import { createTestAuthConfig, disposeTestAuth, testAuthEnvironment } from './support/redis';

afterAll(disposeTestAuth);

it('开发重建清理所属数据并生成新身份，不删除其他归属的向量、文件或 Redis 键', async () => {
  const database = await createTestDatabase();
  const dataDir = await mkdtemp(join(tmpdir(), 'mw-reset-'));
  const auth = createTestAuthConfig();
  const config = {
    ...auth,
    databaseUrl: database.databaseUrl,
    dataDir,
    adminPassword: 'reset-test-password',
    host: '127.0.0.1',
    port: 0,
    appOrigin: 'http://localhost',
    cookieSecure: false,
    webDistDir: null,
    qdrantUrl: process.env.TEST_QDRANT_URL!,
    qdrantApiKey: process.env.TEST_QDRANT_API_KEY!,
  };
  let app: INestApplication | undefined;
  const redis = createClient({ url: auth.redisUrl });
  redis.on('error', () => undefined);
  const other = randomUUID();
  const otherCollection = `mw_${other.replaceAll('-', '')}_reset_test`;
  let ownCollection = '';
  const otherKey = `mw-reset-unrelated-${other}:sentinel`;

  /** 操作本测试的向量集合，不扫描或清理其他集合。 */
  const vector = (name: string, method: string, body?: unknown) =>
    fetch(`${config.qdrantUrl}/collections/${name}`, {
      method,
      headers: { 'api-key': config.qdrantApiKey, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    await redis.connect();
    app = await createApplication(config);
    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post('/api/auth/login')
      .send({ password: config.adminPassword })
      .expect(200);
    const cookie = String(login.headers['set-cookie']?.[0]).split(';')[0]!;
    const ownerId = (await agent.get('/api/workspace').expect(200)).body.data.ownerId;
    await agent
      .post('/api/companions')
      .send({ requestId: randomUUID(), name: '待清理', initialProfile: '开发数据' })
      .expect(201);
    ownCollection = `mw_${ownerId.replaceAll('-', '')}_reset_test`;
    for (const collection of [ownCollection, otherCollection])
      expect(
        (await vector(collection, 'PUT', { vectors: { size: 1, distance: 'Cosine' } })).ok,
      ).toBe(true);
    for (const id of [ownerId, other]) {
      await mkdir(join(dataDir, 'avatars', id), { recursive: true });
      await writeFile(join(dataDir, 'avatars', id, 'fixture'), '仅供验收');
    }
    await redis.set(otherKey, 'keep');
    await redis.set(`${auth.redisNamespace}:fixture`, 'remove');
    await app.close();
    app = undefined;
    const result = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('../src/database/migrate-cli.ts', import.meta.url)),
        'reset',
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_URL: config.databaseUrl,
          ...testAuthEnvironment(auth),
          DATA_DIR: dataDir,
          ADMIN_PASSWORD: config.adminPassword,
          QDRANT_URL: config.qdrantUrl,
          QDRANT_API_KEY: config.qdrantApiKey,
        },
      },
    );
    expect(JSON.parse(result.stdout)).toEqual({ status: 'ready', reset: true });
    expect((await vector(ownCollection, 'GET')).status).toBe(404);
    expect((await vector(otherCollection, 'GET')).status).toBe(200);
    expect(await redis.get(`${auth.redisNamespace}:fixture`)).toBeNull();
    expect(await redis.get(otherKey)).toBe('keep');
    await expect(readFile(join(dataDir, 'avatars', ownerId, 'fixture'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(dataDir, 'avatars', other, 'fixture'), 'utf8')).toBe('仅供验收');
    app = await createApplication(config);
    await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', cookie).expect(401);
    const fresh = request.agent(app.getHttpServer());
    await fresh.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    expect((await fresh.get('/api/workspace').expect(200)).body.data.ownerId).not.toBe(ownerId);
    expect((await fresh.get('/api/companions').expect(200)).body.data.items).toEqual([]);
  } finally {
    await app?.close();
    if (redis.isOpen) {
      await redis.del(otherKey);
      redis.destroy();
    }
    for (const name of [ownCollection, otherCollection].filter(Boolean))
      await vector(name, 'DELETE');
    await database.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 30000);
