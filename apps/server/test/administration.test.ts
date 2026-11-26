import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  administrationCallsSchema,
  administrationConfigurationSchema,
  administrationLifecycleSchema,
  administrationMessageSchema,
} from '@memory-weave/contracts';
import request from 'supertest';
import { afterAll, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app';
import { TaskWorkerService } from '../src/modules/tasks/task-worker.service';
import { createTestDatabase } from './support/database';
import { createTestAuthConfig, disposeTestAuth } from './support/redis';

afterAll(disposeTestAuth);

it('F22 管理视图核对实际配置、生成、终端回执和删除范围', async () => {
  const database = await createTestDatabase();
  const dataDir = await mkdtemp(join(tmpdir(), 'memory-weave-management-'));
  const adminPassword = 'isolated-administration-password';
  const app = await createApplication({
    host: '127.0.0.1',
    port: 0,
    databaseUrl: database.databaseUrl,
    dataDir,
    ...createTestAuthConfig(),
    adminPassword,
    qdrantUrl: 'http://127.0.0.1:1',
    qdrantApiKey: 'isolated-vector-key',
    appOrigin: 'http://localhost:5173',
    cookieSecure: false,
    webDistDir: null,
  });
  try {
    const admin = request.agent(app.getHttpServer());
    const management = '/api/management';
    await admin.get(`${management}/configuration`).expect(401);
    await admin.post('/api/auth/login').send({ password: adminPassword }).expect(200);
    const configuration = await admin.get(`${management}/configuration`).expect(200);
    const groups = administrationConfigurationSchema.parse(configuration.body.data).groups;
    expect(groups.find((group) => group.name === 'models')).toMatchObject({
      version: 1,
      update: 'api',
      source: 'default',
    });
    expect(groups.find((group) => group.name === 'peerTalk')?.values).toMatchObject({
      sessionCalls: 6,
      outputTokens: 500,
    });
    expect(JSON.stringify(configuration.body)).not.toContain(adminPassword);
    const companion = (
      await admin
        .post('/api/companions')
        .send({
          requestId: randomUUID(),
          name: '管理验收',
          initialProfile: '保留可追溯的阅读记录。',
        })
        .expect(201)
    ).body.data;
    const room = (
      await admin
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          title: '实际交付',
          companionId: companion.id,
          runtimeEpoch: 1,
        })
        .expect(201)
    ).body.data;
    const sent = (
      await admin
        .post(`/api/chats/${room.id}/messages`)
        .send({ requestId: randomUUID(), text: '这条消息有真实来源。' })
        .expect(201)
    ).body.data;
    const runPath = `${management}/chats/${room.id}/runs/${sent.run.id}`;
    const inputPath = `${management}/conversations/${room.id}/messages/${sent.message.id}`;
    const unread = administrationMessageSchema.parse(
      (await admin.get(inputPath).expect(200)).body.data,
    );
    expect(unread).toMatchObject({
      published: true,
      deleted: false,
      deliveries: [],
      participants: [{ read: null, visible: true }],
    });
    await app.get(TaskWorkerService).start();
    const run = await vi.waitFor(
      async () => {
        const row = (await admin.get(runPath).expect(200)).body.data;
        expect(row.status).toBe('succeeded');
        return row;
      },
      { timeout: 15000, interval: 100 },
    );
    expect(
      run.context.sources.some((item: { messageId: string }) => item.messageId === sent.message.id),
    ).toBe(true);
    const modelPath = `${management}/model-calls?role=chat&conversationId=${room.id}&companionId=${companion.id}&runtimeEpoch=1`;
    const calls = administrationCallsSchema.parse(
      (await admin.get(modelPath).expect(200)).body.data,
    );
    expect(calls.items).toMatchObject([
      { id: run.task.modelCallId, attempts: 1, status: 'succeeded', configVersion: 1 },
    ]);
    await admin
      .post(`/api/companions/${companion.id}/conversations/${room.id}/receive`)
      .send({ requestId: randomUUID(), runtimeEpoch: 1, expectedPermissionVersion: 1 })
      .expect(201);
    const read = administrationMessageSchema.parse(
      (await admin.get(inputPath).expect(200)).body.data,
    );
    expect(read.participants[0]).toMatchObject({ read: { startOffset: 0 }, visible: true });
    const messages = (await admin.get(`/api/chats/${room.id}/messages`).expect(200)).body.data
      .items;
    const output = messages.find((item: { runId?: string }) => item.runId === sent.run.id).message;
    const outputPath = `${management}/conversations/${room.id}/messages/${output.id}`;
    expect(
      administrationMessageSchema.parse((await admin.get(outputPath).expect(200)).body.data)
        .deliveries,
    ).toEqual([]);
    const terminalId = randomUUID();
    await admin
      .post(`/api/chats/${room.id}/deliveries`)
      .send({
        terminalId,
        messages: [{ messageId: output.id, contentVersion: output.contentVersion }],
      })
      .expect(201);
    expect(
      administrationMessageSchema.parse((await admin.get(outputPath).expect(200)).body.data)
        .deliveries,
    ).toMatchObject([{ terminalId }]);
    const conversation = (await admin.get(`/api/conversations/${room.id}`).expect(200)).body.data
      .conversation;
    const deleted = (
      await admin
        .post('/api/lifecycle')
        .send({
          requestId: randomUUID(),
          kind: 'delete_messages',
          conversationId: room.id,
          expectedVersion: conversation.version,
          messages: [{ messageId: sent.message.id, contentVersion: sent.message.contentVersion }],
        })
        .expect(201)
    ).body.data;
    const audit = await vi.waitFor(
      async () => {
        const row = administrationLifecycleSchema.parse(
          (await admin.get(`${management}/lifecycle/${deleted.id}`).expect(200)).body.data,
        );
        expect(row.operation.status).toBe('completed');
        return row;
      },
      { timeout: 15000, interval: 100 },
    );
    expect(audit).toMatchObject({
      selected: 1,
      derived: 1,
      targets: expect.arrayContaining([
        {
          id: expect.any(String),
          messageId: sent.message.id,
          contentVersion: sent.message.contentVersion,
          kind: 'selected',
        },
      ]),
    });
  } finally {
    await app.close();
    await database.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 45000);
