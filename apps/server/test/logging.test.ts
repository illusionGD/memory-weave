import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { DrizzleQueryError } from 'drizzle-orm';
import { Logger, PinoLogger } from 'nestjs-pino';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApplication } from '../src/app';
import { createLogger } from '../src/logging';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';
import { createTestAuthConfig, disposeTestAuth } from './support/redis';

let app: INestApplication;
let database: TestDatabase;
let dataDir: string;
const lines: string[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  dataDir = await mkdtemp(join(tmpdir(), 'mw-logging-'));
  app = await createApplication(
    {
      ...createTestAuthConfig(),
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      adminPassword: 'logging-test-password',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir,
      webDistDir: null,
      qdrantUrl: 'http://127.0.0.1:1',
      qdrantApiKey: 'logging-test-key',
    },
    createLogger(
      { level: 'info', format: 'json' },
      {
        write(line) {
          lines.push(line);
        },
      },
    ),
  );
});

afterAll(async () => {
  await app?.close();
  await database?.dispose();
  await disposeTestAuth();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

it('应用注入的后台 Logger 保留任务标识和错误位置，不输出 SQL、参数及原因消息', async () => {
  lines.length = 0;
  const logger = await app.resolve(PinoLogger);
  const cause = Object.assign(new Error('private-driver-password'), {
    code: 'ER_ACCESS_DENIED_ERROR',
  });
  logger.error(
    {
      event: 'tasks.test.failed',
      taskId: 'test-task',
      err: new DrizzleQueryError('SELECT private_text', ['private-param'], cause),
    },
    '任务执行失败。',
  );
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain('private');
  const entry = JSON.parse(lines[0]!);
  expect(entry).toMatchObject({
    level: 50,
    taskId: 'test-task',
    err: {
      type: 'DrizzleQueryError',
      frames: expect.any(Array),
      cause: { code: 'ER_ACCESS_DENIED_ERROR' },
    },
  });
  expect(entry.err).not.toHaveProperty('message');
  expect(entry.err).not.toHaveProperty('stack');
});

it('Nest 框架直接记录异常时，不将原始异常消息当作日志文案', () => {
  lines.length = 0;
  app.get(Logger).error(new Error('private-framework-error'), 'ExceptionHandler');
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain('private');
  expect(JSON.parse(lines[0]!)).toMatchObject({
    level: 50,
    context: 'ExceptionHandler',
    err: { type: 'Error', frames: expect.any(Array) },
  });
});
