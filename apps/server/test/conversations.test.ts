import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  conversationDetailSchema,
  draftMessageSchema,
  publishedMessageSchema,
} from '@memory-weave/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication } from '../src/app';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';
import { expectApiError } from './support/http';

describe('会话与原文 HTTP 契约', () => {
  let app: INestApplication;
  let database: TestDatabase;
  let dataDir: string;
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    database = await createTestDatabase();
    dataDir = await mkdtemp(join(tmpdir(), 'memory-weave-conversations-'));
    app = await createApplication({
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      adminPassword: 'test-password-for-conversations',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir,
      webDistDir: null,
    });
    agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/auth/login')
      .send({ password: 'test-password-for-conversations' })
      .expect(200);
  });

  afterAll(async () => {
    await app?.close();
    await database?.dispose();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  async function companion(name: string): Promise<{ companionId: string; runtimeEpoch: number }> {
    const response = await agent
      .post('/api/companions')
      .send({
        requestId: randomUUID(),
        name,
        initialProfile: `${name} 的初始设定`,
      })
      .expect(201);
    return {
      companionId: response.body.data.id as string,
      runtimeEpoch: response.body.data.runtimeEpoch as number,
    };
  }

  it('无需灌表创建用户私聊、伴侣私聊与群聊，保留独立成员身份', async () => {
    const a = await companion('会话 A');
    const b = await companion('会话 B');
    for (const shape of [
      { kind: 'private', includeUser: true, companions: [a] },
      { kind: 'private', includeUser: false, companions: [a, b] },
      { kind: 'group', includeUser: true, companions: [a, b] },
    ]) {
      const created = await agent
        .post('/api/conversations')
        .send({
          requestId: randomUUID(),
          title: '共同交流',
          ...shape,
        })
        .expect(201);
      const detail = conversationDetailSchema.parse(created.body.data);
      expect(detail.conversation).toMatchObject({ kind: shape.kind, version: 1, lastSequence: 0 });
      expect(detail.members).toHaveLength(shape.companions.length + Number(shape.includeUser));
      expect(detail.members.filter((member) => member.kind === 'companion')).toEqual(
        expect.arrayContaining(
          shape.companions.map((member) =>
            expect.objectContaining({
              ...member,
              kind: 'companion',
              joinedSequence: 1,
              leftSequence: null,
              permissionVersion: 1,
            }),
          ),
        ),
      );
      const queried = await agent.get(`/api/conversations/${detail.conversation.id}`).expect(200);
      expect(queried.body.data).toEqual(created.body.data);
    }
  });

  it('保存草稿保留实际发言者与来源时间，但不分配发布序号或进入共同历史', async () => {
    const a = await companion('草稿 A');
    const created = await agent
      .post('/api/conversations')
      .send({
        requestId: randomUUID(),
        kind: 'private',
        includeUser: true,
        companions: [a],
        title: '未发布消息',
      })
      .expect(201);
    const id = created.body.data.conversation.id as string;
    const draft = await agent
      .post(`/api/conversations/${id}/messages`)
      .send({
        requestId: randomUUID(),
        speaker: { kind: 'user' },
        expectedConversationVersion: 1,
        text: '我声称是别的伴侣，但发言身份仍然是用户。',
        occurredAt: '2026-10-25T10:00:00.000Z',
      })
      .expect(201);
    const parsed = draftMessageSchema.parse(draft.body.data);
    expect(parsed).toMatchObject({
      state: 'draft',
      sequence: null,
      publishedAt: null,
      revision: 1,
      contentVersion: 1,
      sourceKind: 'user_input',
      speaker: { kind: 'user' },
      occurredAt: '2026-10-25T10:00:00.000Z',
      validFrom: null,
      validUntil: null,
    });
    const detail = await agent.get(`/api/conversations/${id}/messages/${parsed.id}`).expect(200);
    expect(detail.body.data).toEqual(draft.body.data);
    const history = await agent.get(`/api/conversations/${id}/messages`).expect(200);
    expect(history.body.data).toEqual({ items: [], nextAfterSequence: null });
    const conversation = await agent.get(`/api/conversations/${id}`).expect(200);
    expect(conversation.body.data.conversation.lastSequence).toBe(0);
  });

  it('正式发布分配共享顺序并独立于草稿修订，重复发布不会产生第二条经历', async () => {
    const a = await companion('发布 A');
    const created = await agent
      .post('/api/conversations')
      .send({
        requestId: randomUUID(),
        kind: 'private',
        includeUser: true,
        companions: [a],
        title: '正式发布',
      })
      .expect(201);
    const id = created.body.data.conversation.id as string;
    const draft = await agent
      .post(`/api/conversations/${id}/messages`)
      .send({
        requestId: randomUUID(),
        speaker: { kind: 'companion', ...a },
        expectedConversationVersion: 1,
        text: '我是 A 的发言。',
      })
      .expect(201);
    const command = {
      requestId: randomUUID(),
      expectedRevision: 1,
      expectedConversationVersion: 1,
    };
    const published = await agent
      .post(`/api/conversations/${id}/messages/${draft.body.data.id}/publish`)
      .send(command)
      .expect(201);
    const parsed = publishedMessageSchema.parse(published.body.data);
    expect(parsed).toMatchObject({
      id: draft.body.data.id,
      revision: 2,
      contentVersion: 1,
      sequence: 1,
      sourceKind: 'admin_companion_input',
      speaker: { kind: 'companion', ...a },
    });
    const replay = await agent
      .post(`/api/conversations/${id}/messages/${parsed.id}/publish`)
      .send(command)
      .expect(201);
    expect(replay.body.data).toEqual(published.body.data);
    const history = await agent.get(`/api/conversations/${id}/messages`).expect(200);
    expect(history.body.data.items).toEqual([published.body.data]);
    const conversation = await agent.get(`/api/conversations/${id}`).expect(200);
    expect(conversation.body.data.conversation).toMatchObject({ lastSequence: 1, version: 2 });
  });

  it('会话列表使用稳定游标分页且每页有界', async () => {
    const a = await companion('分页 A');
    const expectedIds: string[] = [];
    for (const title of ['第一页候选', '第二页候选', '第三页候选']) {
      const created = await agent
        .post('/api/conversations')
        .send({
          requestId: randomUUID(),
          kind: 'private',
          includeUser: true,
          companions: [a],
          title,
        })
        .expect(201);
      expectedIds.push(created.body.data.conversation.id as string);
    }
    const collected: string[] = [];
    let afterId: string | undefined;
    do {
      const page = await agent
        .get('/api/conversations')
        .query({ limit: 2, ...(afterId ? { afterId } : {}) })
        .expect(200);
      expect(page.body.data.items.length).toBeLessThanOrEqual(2);
      collected.push(...page.body.data.items.map((item: { id: string }) => item.id));
      afterId = (page.body.data.nextAfterId as string | null) ?? undefined;
    } while (afterId);
    expect(collected).toEqual(expect.arrayContaining(expectedIds));
    expect(new Set(collected).size).toBe(collected.length);
    await agent.get('/api/conversations').query({ limit: 101 }).expect(400);
  });

  it('未知发生时间保持未知，不用接收时间替代历史事件时间', async () => {
    const a = await companion('时间 A');
    const created = await agent
      .post('/api/conversations')
      .send({
        requestId: randomUUID(),
        kind: 'private',
        includeUser: true,
        companions: [a],
        title: '未知发生时间',
      })
      .expect(201);
    const id = created.body.data.conversation.id as string;
    for (const time of [{}, { occurredAt: null }]) {
      const saved = await agent
        .post(`/api/conversations/${id}/messages`)
        .send({
          requestId: randomUUID(),
          speaker: { kind: 'user' },
          expectedConversationVersion: 1,
          text: '某个时间发生过的事',
          ...time,
        })
        .expect(201);
      expect(saved.body.data.occurredAt).toBeNull();
      expect(saved.body.data.receivedAt).toEqual(expect.stringMatching(/Z$/));
    }
  });

  it('来源只引用同会话已发布确切版本，转述保留实际发言者和来源', async () => {
    const a = await companion('来源 A');
    const b = await companion('来源 B');
    const personal = await agent
      .post('/api/conversations')
      .send({
        requestId: randomUUID(),
        kind: 'private',
        includeUser: true,
        companions: [a],
        title: '来源私聊',
      })
      .expect(201);
    const group = await agent
      .post('/api/conversations')
      .send({
        requestId: randomUUID(),
        kind: 'group',
        includeUser: true,
        companions: [a, b],
        title: '来源群聊',
      })
      .expect(201);
    const privateId = personal.body.data.conversation.id as string;
    const original = await agent
      .post(`/api/conversations/${privateId}/messages`)
      .send({
        requestId: randomUUID(),
        speaker: { kind: 'user' },
        expectedConversationVersion: 1,
        text: '只有原私聊可见的经历',
      })
      .expect(201);
    const source = {
      messageId: original.body.data.id as string,
      contentVersion: 1,
      relation: 'report',
    };
    const report = {
      requestId: randomUUID(),
      speaker: { kind: 'companion', ...a },
      expectedConversationVersion: 1,
      text: '转述',
      epistemicKind: 'report',
      sources: [source],
    };
    await agent.post(`/api/conversations/${privateId}/messages`).send(report).expect(404);
    await agent
      .post(`/api/conversations/${privateId}/messages/${source.messageId}/publish`)
      .send({
        requestId: randomUUID(),
        expectedRevision: 1,
        expectedConversationVersion: 1,
      })
      .expect(201);
    await agent
      .post(`/api/conversations/${group.body.data.conversation.id}/messages`)
      .send(report)
      .expect(404);
    await agent
      .post(`/api/conversations/${privateId}/messages`)
      .send({
        ...report,
        expectedConversationVersion: 2,
        sources: [{ ...source, contentVersion: 2 }],
      })
      .expect(404);
    const valid = await agent
      .post(`/api/conversations/${privateId}/messages`)
      .send({ ...report, expectedConversationVersion: 2, replyToMessageId: source.messageId })
      .expect(201);
    expect(valid.body.data).toMatchObject({
      epistemicKind: 'report',
      sources: [source],
      sourceKind: 'admin_companion_input',
      speaker: { kind: 'companion', ...a },
      replyToMessageId: source.messageId,
    });
    const published = await agent
      .post(`/api/conversations/${privateId}/messages/${valid.body.data.id}/publish`)
      .send({
        requestId: randomUUID(),
        expectedRevision: 1,
        expectedConversationVersion: 2,
      })
      .expect(201);
    expect(published.body.data.sources).toEqual([source]);
    expect(published.body.data.sequence).toBe(2);
  });

  it('并发发布通过会话版本只接纳一个写入，重试后连续排序且分页不漏消息', async () => {
    const a = await companion('并发 A');
    const created = await agent
      .post('/api/conversations')
      .send({
        requestId: randomUUID(),
        kind: 'private',
        includeUser: true,
        companions: [a],
        title: '并发顺序',
      })
      .expect(201);
    const id = created.body.data.conversation.id as string;
    const first = await agent
      .post(`/api/conversations/${id}/messages`)
      .send({
        requestId: randomUUID(),
        speaker: { kind: 'user' },
        expectedConversationVersion: 1,
        text: '并发一',
      })
      .expect(201);
    const second = await agent
      .post(`/api/conversations/${id}/messages`)
      .send({
        requestId: randomUUID(),
        speaker: { kind: 'user' },
        expectedConversationVersion: 1,
        text: '并发二',
      })
      .expect(201);
    const drafts = [first.body.data.id as string, second.body.data.id as string];
    const commands = drafts.map(() => ({
      requestId: randomUUID(),
      expectedRevision: 1,
      expectedConversationVersion: 1,
    }));
    const concurrent = await Promise.all(
      drafts.map((messageId, index) =>
        agent.post(`/api/conversations/${id}/messages/${messageId}/publish`).send(commands[index]),
      ),
    );
    expect(concurrent.map((response) => response.status).sort()).toEqual([201, 409]);
    const winner = concurrent.findIndex((response) => response.status === 201);
    const loser = concurrent.findIndex((response) => response.status === 409);
    const firstPage = await agent
      .get(`/api/conversations/${id}/messages`)
      .query({ limit: 1 })
      .expect(200);
    expect(firstPage.body.data.items).toHaveLength(1);
    expect(firstPage.body.data.items[0]).toMatchObject({ id: drafts[winner], sequence: 1 });
    await agent
      .post(`/api/conversations/${id}/messages/${drafts[loser]}/publish`)
      .send({
        requestId: randomUUID(),
        expectedRevision: 1,
        expectedConversationVersion: 2,
      })
      .expect(201);
    const replay = await agent
      .post(`/api/conversations/${id}/messages/${drafts[winner]}/publish`)
      .send(commands[winner])
      .expect(201);
    expect(replay.body.data).toEqual(concurrent[winner]?.body.data);
    const pageOne = await agent
      .get(`/api/conversations/${id}/messages`)
      .query({ limit: 1 })
      .expect(200);
    expect(pageOne.body.data.nextAfterSequence).toBe(1);
    const pageTwo = await agent
      .get(`/api/conversations/${id}/messages`)
      .query({ limit: 1, afterSequence: 1 })
      .expect(200);
    expect(pageTwo.body.data.items).toHaveLength(1);
    expect(pageTwo.body.data.items[0]).toMatchObject({ id: drafts[loser], sequence: 2 });
    expect(pageTwo.body.data.nextAfterSequence).toBeNull();
  });

  it('创建与保存的并发重试复用同一对象，异载荷或跨消息复用发布键回滚', async () => {
    const a = await companion('幂等 A');
    const command = {
      requestId: randomUUID(),
      kind: 'private',
      includeUser: true,
      companions: [a],
      title: '创建幂等',
    };
    const created = await Promise.all([
      agent.post('/api/conversations').send(command),
      agent.post('/api/conversations').send(command),
    ]);
    expect(created.map((response) => response.status)).toEqual([201, 201]);
    expect(created[0]?.body.data).toEqual(created[1]?.body.data);
    const id = created[0]?.body.data.conversation.id as string;
    await agent
      .post('/api/conversations')
      .send({ ...command, title: '异载荷' })
      .expect(409);
    const messageCommand = {
      requestId: randomUUID(),
      speaker: { kind: 'user' },
      expectedConversationVersion: 1,
      text: '同一原文',
    };
    const saved = await Promise.all([
      agent.post(`/api/conversations/${id}/messages`).send(messageCommand),
      agent.post(`/api/conversations/${id}/messages`).send(messageCommand),
    ]);
    expect(saved.map((response) => response.status)).toEqual([201, 201]);
    expect(saved[0]?.body.data).toEqual(saved[1]?.body.data);
    const originalId = saved[0]?.body.data.id as string;
    const changedContent = await agent
      .post(`/api/conversations/${id}/messages`)
      .send({ ...messageCommand, text: '变更原文' })
      .expect(409);
    expectApiError(changedContent, 409, 40901);
    const publishCommand = {
      requestId: randomUUID(),
      expectedRevision: 1,
      expectedConversationVersion: 1,
    };
    const staleRevision = await agent
      .post(`/api/conversations/${id}/messages/${originalId}/publish`)
      .send({ ...publishCommand, expectedRevision: 2 })
      .expect(409);
    expectApiError(staleRevision, 409, 40902);
    await agent
      .post(`/api/conversations/${id}/messages/${originalId}/publish`)
      .send(publishCommand)
      .expect(201);
    const next = await agent
      .post(`/api/conversations/${id}/messages`)
      .send({
        ...messageCommand,
        requestId: randomUUID(),
        expectedConversationVersion: 2,
      })
      .expect(201);
    await agent
      .post(`/api/conversations/${id}/messages/${next.body.data.id}/publish`)
      .send({
        ...publishCommand,
        expectedConversationVersion: 2,
      })
      .expect(409);
    const nextState = await agent
      .get(`/api/conversations/${id}/messages/${next.body.data.id}`)
      .expect(200);
    expect(nextState.body.data).toMatchObject({ state: 'draft', revision: 1, sequence: null });
    const conversation = await agent.get(`/api/conversations/${id}`).expect(200);
    expect(conversation.body.data.conversation).toMatchObject({ version: 2, lastSequence: 1 });
  });

  it('身份只来自认证归属与当前成员，不能指定owner、伪造用户或越代次发言', async () => {
    const a = await companion('身份 A');
    const b = await companion('身份 B');
    const c = await companion('身份 C');
    const command = {
      requestId: randomUUID(),
      kind: 'private',
      includeUser: false,
      companions: [a, b],
      title: '仅伴侣私聊',
    };
    await request(app.getHttpServer()).post('/api/conversations').send(command).expect(401);
    await agent
      .post('/api/conversations')
      .send({ ...command, ownerId: randomUUID() })
      .expect(400);
    await agent
      .post('/api/conversations')
      .send({ ...command, companions: [a, { ...a, companionId: a.companionId.toUpperCase() }] })
      .expect(400);
    await agent
      .post('/api/conversations')
      .send({ ...command, companions: [{ ...a, runtimeEpoch: 2 }, b] })
      .expect(409);
    const created = await agent.post('/api/conversations').send(command).expect(201);
    const id = created.body.data.conversation.id as string;
    const message = {
      requestId: randomUUID(),
      expectedConversationVersion: 1,
      text: '未经授权发言',
    };
    await agent
      .post(`/api/conversations/${id}/messages`)
      .send({ ...message, speaker: { kind: 'user' } })
      .expect(404);
    await agent
      .post(`/api/conversations/${id}/messages`)
      .send({ ...message, speaker: { kind: 'user', userId: randomUUID() } })
      .expect(400);
    await agent
      .post(`/api/conversations/${id}/messages`)
      .send({ ...message, speaker: { kind: 'companion', ...c } })
      .expect(404);
    await agent
      .post(`/api/conversations/${id}/messages`)
      .send({ ...message, speaker: { kind: 'companion', ...a, runtimeEpoch: 2 } })
      .expect(409);
    await agent
      .post(`/api/conversations/${id}/messages`)
      .send({ ...message, speaker: { kind: 'companion', companionId: a.companionId } })
      .expect(400);
    const accepted = await agent
      .post(`/api/conversations/${id}/messages`)
      .send({
        ...message,
        speaker: { kind: 'companion', ...a },
        text: '我自称是 B，但真实发言者仍为 A。',
      })
      .expect(201);
    expect(accepted.body.data.speaker).toEqual({ kind: 'companion', ...a });
  });
});
