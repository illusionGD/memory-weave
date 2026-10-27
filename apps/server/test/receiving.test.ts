import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  companionDetailSchema,
  conversationDetailSchema,
  conversationProgressResponseSchema,
  draftMessageSchema,
  publishedMessageSchema,
  receiveMessagesResponseSchema,
} from '@memory-weave/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../src/app';
import type { ServerConfig } from '../src/config';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';
import { expectApiError, expectApiSuccess } from './support/http';

describe('伴侣视角的原文查询与独立接收', () => {
  let app: INestApplication;
  let database: TestDatabase;
  let dataDir: string;
  let config: ServerConfig;
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.dispose();
  });

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memory-weave-receiving-'));
    config = {
      qdrantUrl: process.env.TEST_QDRANT_URL ?? 'http://127.0.0.1:1',
      qdrantApiKey: process.env.TEST_QDRANT_API_KEY ?? 'test-vector-key',
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      adminPassword: 'test-password-for-receiving',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir,
      webDistDir: null,
    };
    app = await createApplication(config);
    agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
  });

  afterEach(async () => {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function createCompanion(name: string) {
    const response = await agent
      .post('/api/companions')
      .send({ requestId: randomUUID(), name, initialProfile: '只用于隔离验收的初始设定。' })
      .expect(201);
    return companionDetailSchema.parse(response.body.data);
  }

  async function createConversation(companionIds: string[], includeUser = true) {
    const response = await agent
      .post('/api/conversations')
      .send({
        requestId: randomUUID(),
        title: '伴侣读取验收',
        kind: companionIds.length + Number(includeUser) === 2 ? 'private' : 'group',
        includeUser,
        companions: companionIds.map((companionId) => ({ companionId, runtimeEpoch: 1 })),
      })
      .expect(201);
    return conversationDetailSchema.parse(response.body.data);
  }

  async function saveMessage(conversationId: string, text: string) {
    const detail = await agent.get(`/api/conversations/${conversationId}`).expect(200);
    const conversation = conversationDetailSchema.parse(detail.body.data).conversation;
    const response = await agent
      .post(`/api/conversations/${conversationId}/messages`)
      .send({
        requestId: randomUUID(),
        speaker: { kind: 'user' },
        expectedConversationVersion: conversation.version,
        text,
      })
      .expect(201);
    return draftMessageSchema.parse(response.body.data);
  }

  async function publishMessage(conversationId: string, text: string) {
    const draft = await saveMessage(conversationId, text);
    const detail = await agent.get(`/api/conversations/${conversationId}`).expect(200);
    const conversation = conversationDetailSchema.parse(detail.body.data).conversation;
    const response = await agent
      .post(`/api/conversations/${conversationId}/messages/${draft.id}/publish`)
      .send({
        requestId: randomUUID(),
        expectedRevision: draft.revision,
        expectedConversationVersion: conversation.version,
      })
      .expect(201);
    return publishedMessageSchema.parse(response.body.data);
  }

  it('新会话的原文查询仅允许当前代次的成员访问', async () => {
    const a = await createCompanion('接收者 A');
    const b = await createCompanion('未加入私聊的 B');
    const { conversation } = await createConversation([a.id]);
    const path = `/api/companions/${a.id}/conversations/${conversation.id}/messages`;
    await agent
      .get(path)
      .query({ runtimeEpoch: 1 })
      .expect(200)
      .expect((response) =>
        expectApiSuccess(response, {
          items: [],
          nextAfterSequence: null,
        }),
      );
    const stale = await agent.get(path).query({ runtimeEpoch: 2 }).expect(409);
    expectApiError(stale, 409, 40903);
    const denied = await agent
      .get(`/api/companions/${b.id}/conversations/${conversation.id}/messages`)
      .query({ runtimeEpoch: 1 })
      .expect(404);
    expectApiError(denied, 404, 404);
  });

  it('空接收批次也持久保存并幂等重放，同键改变参数不能替换原批次', async () => {
    const a = await createCompanion('空批次接收者');
    const { conversation } = await createConversation([a.id]);
    const path = `/api/companions/${a.id}/conversations/${conversation.id}/receive`;
    const command = { requestId: randomUUID(), runtimeEpoch: 1, expectedPermissionVersion: 1 };
    const first = await agent.post(path).send(command).expect(201);
    const batch = receiveMessagesResponseSchema.parse(first.body.data);
    expect(batch).toMatchObject({
      companionId: a.id,
      runtimeEpoch: 1,
      conversationId: conversation.id,
      items: [],
      nextAfterSequence: null,
    });
    await agent
      .post(path)
      .send(command)
      .expect(201)
      .expect((response) => expectApiSuccess(response, first.body.data));
    await agent
      .post(path)
      .send({ ...command, limit: 1 })
      .expect(409);
    await agent
      .post(path)
      .send({ ...command, runtimeEpoch: 2 })
      .expect(409);
    const changedPermission = await agent
      .post(path)
      .send({ ...command, expectedPermissionVersion: 2 })
      .expect(409);
    expectApiError(changedPermission, 409, 40904);
  });
  it('普通查看不记已读，A 与 B 分别取得同一原文且整理和交付保持独立状态', async () => {
    const a = await createCompanion('独立取得 A');
    const b = await createCompanion('独立取得 B');
    const { conversation } = await createConversation([a.id, b.id]);
    const published = await publishMessage(conversation.id, 'A🌙B');
    await saveMessage(conversation.id, '草稿不进入接收批次或整理进度。');
    const aBase = `/api/companions/${a.id}/conversations/${conversation.id}`;
    const bBase = `/api/companions/${b.id}/conversations/${conversation.id}`;
    await agent
      .get(`${aBase}/messages`)
      .query({ runtimeEpoch: 1 })
      .expect(200)
      .expect((response) =>
        expectApiSuccess(response, {
          items: [published],
          nextAfterSequence: null,
        }),
      );
    const pending = {
      items: [
        {
          messageId: published.id,
          contentVersion: 1,
          sequence: 1,
          readReceipt: null,
          processing: 'pending',
          delivery: 'not_recorded',
        },
      ],
      nextAfterSequence: null,
    };
    await agent
      .get(`${aBase}/progress`)
      .query({ runtimeEpoch: 1 })
      .expect(200)
      .expect((response) => expectApiSuccess(response, pending));
    await agent
      .get(`${bBase}/progress`)
      .query({ runtimeEpoch: 1 })
      .expect(200)
      .expect((response) => expectApiSuccess(response, pending));
    const aReceived = await agent
      .post(`${aBase}/receive`)
      .send({
        requestId: randomUUID(),
        runtimeEpoch: 1,
        expectedPermissionVersion: 1,
      })
      .expect(201);
    expect(aReceived.body.data.items).toEqual([published]);
    const aProgress = conversationProgressResponseSchema.parse(
      (await agent.get(`${aBase}/progress`).query({ runtimeEpoch: 1 }).expect(200)).body.data,
    );
    expect(aProgress.items[0]).toMatchObject({
      messageId: published.id,
      contentVersion: 1,
      sequence: 1,
      readReceipt: {
        companionId: a.id,
        runtimeEpoch: 1,
        conversationId: conversation.id,
        messageId: published.id,
        contentVersion: 1,
        startOffset: 0,
        endOffset: 4,
      },
      processing: 'pending',
      delivery: 'not_recorded',
    });
    await agent
      .get(`${bBase}/progress`)
      .query({ runtimeEpoch: 1 })
      .expect(200)
      .expect((response) => expectApiSuccess(response, pending));
    const bReceived = await agent
      .post(`${bBase}/receive`)
      .send({
        requestId: randomUUID(),
        runtimeEpoch: 1,
        expectedPermissionVersion: 1,
      })
      .expect(201);
    expect(bReceived.body.data.items).toEqual([published]);
    const bProgress = conversationProgressResponseSchema.parse(
      (await agent.get(`${bBase}/progress`).query({ runtimeEpoch: 1 }).expect(200)).body.data,
    );
    expect(bProgress.items[0]?.readReceipt?.companionId).toBe(b.id);
    expect(bProgress.items[0]?.readReceipt?.id).not.toBe(aProgress.items[0]?.readReceipt?.id);
    expect(bProgress.items[0]?.processing).toBe('pending');
    expect(bProgress.items[0]?.delivery).toBe('not_recorded');
  });
  it('来源回查绑定内容版本与成员权限，共同群聊不开放另一场私聊或草稿', async () => {
    const a = await createCompanion('来源读取 A');
    const b = await createCompanion('来源读取 B');
    await createConversation([a.id, b.id]);
    const { conversation } = await createConversation([a.id]);
    const published = await publishMessage(conversation.id, '这段原文仅属于用户与 A 的私聊。');
    const draft = await saveMessage(conversation.id, '尚未正式发布的来源。');
    const sourcePath = `/api/companions/${a.id}/sources/${published.id}`;
    await agent
      .get(sourcePath)
      .query({ runtimeEpoch: 1, contentVersion: 1 })
      .expect(200)
      .expect((response) => expectApiSuccess(response, published));
    await agent.get(sourcePath).query({ runtimeEpoch: 1, contentVersion: 2 }).expect(404);
    await agent.get(sourcePath).query({ runtimeEpoch: 2, contentVersion: 1 }).expect(409);
    await agent
      .get(`/api/companions/${a.id}/sources/${draft.id}`)
      .query({ runtimeEpoch: 1, contentVersion: 1 })
      .expect(404);
    await agent
      .get(`/api/companions/${b.id}/sources/${published.id}`)
      .query({ runtimeEpoch: 1, contentVersion: 1 })
      .expect(404);
    const progress = await agent
      .get(`/api/companions/${a.id}/conversations/${conversation.id}/progress`)
      .query({ runtimeEpoch: 1 })
      .expect(200);
    expect(progress.body.data.items[0].readReceipt).toBeNull();
  });
  it('新增消息和重启不改变原接收批次，跳过的序号保持未读', async () => {
    const a = await createCompanion('稳定批次接收者');
    const { conversation } = await createConversation([a.id]);
    const firstMessage = await publishMessage(conversation.id, '第一次接收时只有这一条。');
    const base = `/api/companions/${a.id}/conversations/${conversation.id}`;
    // 默认 limit=20：新增消息后若错误地重新查询，旧批次响应就会发生变化。
    const command = { requestId: randomUUID(), runtimeEpoch: 1, expectedPermissionVersion: 1 };
    const first = await agent.post(`${base}/receive`).send(command).expect(201);
    expect(first.body.data.items).toEqual([firstMessage]);
    expect(first.body.data.nextAfterSequence).toBe(1);
    const secondMessage = await publishMessage(conversation.id, '这条暂时跳过，不可冒充已读。');
    const thirdMessage = await publishMessage(conversation.id, '之后明确取得第三条。');
    await agent
      .post(`${base}/receive`)
      .send(command)
      .expect(201)
      .expect((response) => expectApiSuccess(response, first.body.data));
    const skipped = await agent
      .post(`${base}/receive`)
      .send({
        requestId: randomUUID(),
        runtimeEpoch: 1,
        expectedPermissionVersion: 1,
        afterSequence: 2,
      })
      .expect(201);
    expect(skipped.body.data.items).toEqual([thirdMessage]);
    const progress = conversationProgressResponseSchema.parse(
      (await agent.get(`${base}/progress`).query({ runtimeEpoch: 1 }).expect(200)).body.data,
    );
    expect(progress.items.map((item) => [item.messageId, item.readReceipt !== null])).toEqual([
      [firstMessage.id, true],
      [secondMessage.id, false],
      [thirdMessage.id, true],
    ]);
    const page = await agent
      .get(`${base}/messages`)
      .query({ runtimeEpoch: 1, limit: 1 })
      .expect(200);
    expect(page.body.data).toEqual({ items: [firstMessage], nextAfterSequence: 1 });
    await agent
      .get(`${base}/messages`)
      .query({ runtimeEpoch: 1, limit: 1, afterSequence: 1 })
      .expect(200)
      .expect((response) =>
        expectApiSuccess(response, { items: [secondMessage], nextAfterSequence: 2 }),
      );
    await agent
      .get(`${base}/progress`)
      .query({ runtimeEpoch: 1, limit: 1, afterSequence: 1 })
      .expect(200)
      .expect((response) =>
        expectApiSuccess(response, { items: [progress.items[1]], nextAfterSequence: 2 }),
      );
    await app.close();
    app = await createApplication(config);
    agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
    await agent
      .post(`${base}/receive`)
      .send(command)
      .expect(201)
      .expect((response) => expectApiSuccess(response, first.body.data));
    await agent
      .get(`${base}/progress`)
      .query({ runtimeEpoch: 1 })
      .expect(200)
      .expect((response) => expectApiSuccess(response, progress));
  });
  it('并发重试复用一个批次，新的接收命令保留首次读取记录且不占用其他实例的幂等键', async () => {
    const a = await createCompanion('并发接收 A');
    const b = await createCompanion('并发接收 B');
    const { conversation } = await createConversation([a.id, b.id]);
    const published = await publishMessage(conversation.id, '多次取得仍只记录首次读取。');
    const aBase = `/api/companions/${a.id}/conversations/${conversation.id}`;
    const command = { requestId: randomUUID(), runtimeEpoch: 1, expectedPermissionVersion: 1 };
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () => agent.post(`${aBase}/receive`).send(command)),
    );
    const first = concurrent[0]!;
    for (const response of concurrent) {
      expect(response.status).toBe(201);
      expect(response.body.data).toEqual(first.body.data);
    }
    expect(first.body.data.items).toEqual([published]);
    const initialProgress = await agent
      .get(`${aBase}/progress`)
      .query({ runtimeEpoch: 1 })
      .expect(200);
    const subsequent = await agent
      .post(`${aBase}/receive`)
      .send({
        ...command,
        requestId: randomUUID(),
      })
      .expect(201);
    expect(subsequent.body.data.batchId).not.toBe(first.body.data.batchId);
    await agent
      .get(`${aBase}/progress`)
      .query({ runtimeEpoch: 1 })
      .expect(200)
      .expect((response) => expectApiSuccess(response, initialProgress.body.data));
    const bReceived = await agent
      .post(`/api/companions/${b.id}/conversations/${conversation.id}/receive`)
      .send(command)
      .expect(201);
    expect(bReceived.body.data.items).toEqual([published]);
    expect(bReceived.body.data.batchId).not.toBe(first.body.data.batchId);
    expect(bReceived.body.data.companionId).toBe(b.id);
  });
  it('全部读取入口要求登录和显式代次，拒绝越界分页、伪造字段及非成员接收', async () => {
    const a = await createCompanion('参数校验 A');
    const b = await createCompanion('非成员 B');
    const { conversation } = await createConversation([a.id]);
    const base = `/api/companions/${a.id}/conversations/${conversation.id}`;
    for (const route of ['messages', 'progress']) {
      await request(app.getHttpServer())
        .get(`${base}/${route}`)
        .query({ runtimeEpoch: 1 })
        .expect(401);
      await agent.get(`${base}/${route}`).expect(400);
      await agent.get(`${base}/${route}`).query({ runtimeEpoch: 1, limit: 101 }).expect(400);
      await agent
        .get(`${base}/${route}`)
        .query({ runtimeEpoch: 1, afterSequence: 2147483648 })
        .expect(400);
      await agent
        .get(`${base}/${route}`)
        .query({ runtimeEpoch: 1, ownerId: randomUUID() })
        .expect(400);
    }
    await request(app.getHttpServer()).post(`${base}/receive`).send({}).expect(401);
    await request(app.getHttpServer())
      .get(`/api/companions/${a.id}/sources/${randomUUID()}`)
      .query({ runtimeEpoch: 1, contentVersion: 1 })
      .expect(401);
    await agent
      .get(`/api/companions/${a.id}/sources/${randomUUID()}`)
      .query({ runtimeEpoch: 1 })
      .expect(400);
    await agent
      .get('/api/companions/not-a-uuid/conversations/not-a-uuid/messages')
      .query({ runtimeEpoch: 1 })
      .expect(400);
    const command = { requestId: randomUUID(), runtimeEpoch: 1, expectedPermissionVersion: 1 };
    await agent
      .post(`${base}/receive`)
      .send({ ...command, ownerId: randomUUID() })
      .expect(400);
    await agent
      .post(`${base}/receive`)
      .send({ ...command, companionId: b.id })
      .expect(400);
    await agent
      .post(`/api/companions/${b.id}/conversations/${conversation.id}/receive`)
      .send(command)
      .expect(404);
    await agent
      .get(`/api/companions/${b.id}/conversations/${conversation.id}/progress`)
      .query({ runtimeEpoch: 1 })
      .expect(404);
  });
});
