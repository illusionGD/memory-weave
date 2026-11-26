import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  autonomyOpportunitiesSchema,
  conversationDetailSchema,
  groupTurnSchema,
  peerProfilesSchema,
  peerSessionsSchema,
} from '@memory-weave/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app';
import { autonomyConfigurationSchema } from '../src/modules/autonomy/autonomy-config';
import { autonomyChoiceSchema } from '../src/modules/autonomy/autonomy-definition';
import { peerReplySchema } from '../src/modules/group-turns/group-turn-definition';
import { ModelRuntimeService } from '../src/modules/models/model-runtime.service';
import { peerConfigurationSchema } from '../src/modules/peer-talk/peer-config';
import { TaskWorkerService } from '../src/modules/tasks/task-worker.service';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';
import { createTestAuthConfig, disposeTestAuth } from './support/redis';

afterAll(disposeTestAuth);

const password = 'isolated-peer-test-password';
const wait = { timeout: 18000, interval: 100 };

describe('F20 自主同伴交流', () => {
  let database: TestDatabase;
  let directory: string;
  let app: INestApplication;
  let owner: ReturnType<typeof request.agent>;

  beforeEach(async () => {
    database = await createTestDatabase();
    directory = await mkdtemp(join(tmpdir(), 'memory-weave-peer-'));
  });

  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
    await database?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  /** 按场次和实例分别配置额度，保留真实模型记录与持久化过程。 */
  async function boot(sessionCalls = 3, modelCallsPerDay = 12) {
    app = await createApplication({
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      qdrantUrl: 'http://127.0.0.1:1',
      qdrantApiKey: 'isolated-vector-key',
      ...createTestAuthConfig(),
      adminPassword: password,
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir: directory,
      webDistDir: null,
      peerConfiguration: peerConfigurationSchema.parse({ sessionCalls }),
      autonomyConfiguration: autonomyConfigurationSchema.parse({ modelCallsPerDay }),
    });
    owner = request.agent(app.getHttpServer());
    await owner.post('/api/auth/login').send({ password }).expect(200);
  }

  /** 只有主动配置的简介可被发现。 */
  async function companion(name: string, optsIn = true) {
    const id: string = (
      await owner
        .post('/api/companions')
        .send({ requestId: randomUUID(), name, initialProfile: `${name}的私有人设。` })
        .expect(201)
    ).body.data.id;
    if (optsIn)
      await owner
        .put(`/api/companions/${id}/peer-policy`)
        .send({
          runtimeEpoch: 1,
          requestId: randomUUID(),
          expectedVersion: 0,
          enabled: true,
          publicDescription: `${name}的公开简介。`,
          invitationDecision: 'accept',
          allowExit: true,
        })
        .expect(200);
    return id;
  }

  /** 为会话设置明确的自主交流许可。 */
  async function group(ids: string[]) {
    const response = await owner
      .post('/api/conversations')
      .send({
        requestId: randomUUID(),
        kind: 'group',
        title: '交流验收',
        includeUser: true,
        companions: ids.map((companionId) => ({ companionId, runtimeEpoch: 1 })),
      })
      .expect(201);
    const { conversation } = conversationDetailSchema.parse(response.body.data);
    const path = `/api/conversations/${conversation.id}`;
    await owner
      .put(`${path}/peer-policy`)
      .send({ requestId: randomUUID(), expectedVersion: 0, enabled: true, allowExit: true })
      .expect(200);
    return path;
  }

  /** 先发布原始消息，随后后台才能发现真实话题。 */
  async function publish(path: string, text: string, companionId?: string) {
    const expectedConversationVersion = (await detail(path)).conversation.version;
    const draft = (
      await owner
        .post(`${path}/messages`)
        .send({
          requestId: randomUUID(),
          speaker: companionId
            ? { kind: 'companion', companionId, runtimeEpoch: 1 }
            : { kind: 'user' },
          expectedConversationVersion,
          text,
        })
        .expect(201)
    ).body.data;
    return (
      await owner
        .post(`${path}/messages/${draft.id}/publish`)
        .send({
          requestId: randomUUID(),
          expectedRevision: draft.revision,
          expectedConversationVersion,
        })
        .expect(201)
    ).body.data.id as string;
  }

  /** 通过公开接口读取当前会话状态。 */
  async function detail(path: string) {
    return conversationDetailSchema.parse((await owner.get(path).expect(200)).body.data);
  }

  /** 读取实际发送的调用数和真实的轮次记录。 */
  async function sessions(path: string) {
    return peerSessionsSchema.parse(
      (await owner.get(`${path}/peer-sessions`).expect(200)).body.data,
    ).items;
  }

  /** 等待整场真正完成。 */
  async function finish(path: string) {
    return vi.waitFor(async () => {
      const [session] = await sessions(path);
      expect(session).toBeDefined();
      const turn = groupTurnSchema.parse(
        (await owner.get(`${path}/turns/${session!.id}`).expect(200)).body.data,
      );
      expect(turn.task.status).toBe('succeeded');
      return { session: (await sessions(path)).find((item) => item.id === session!.id)!, turn };
    }, wait);
  }

  /** 只替换给定测试场景的模型候选。 */
  function fixture(output: (companionId: string) => unknown, peerId?: string) {
    const runtime = app.get(ModelRuntimeService);
    const actual = runtime.execute.bind(runtime);
    const seen: number[] = [];
    vi.spyOn(runtime, 'execute').mockImplementation(
      (ownerId, command, definition, scope, guard) => {
        if (definition.outputSchema === peerReplySchema) {
          seen.push(definition.maxOutputTokens!);
          return actual(
            ownerId,
            command,
            { ...definition, testOutput: () => output(scope!.companionId!) },
            scope,
            guard,
          );
        }
        if (peerId && definition.outputSchema === autonomyChoiceSchema)
          return actual(
            ownerId,
            command,
            {
              ...definition,
              testOutput: () => ({
                choice: 'peer_invite',
                text: null,
                reason: '共同交流测试。',
                peerId,
              }),
            },
            scope,
            guard,
          );
        return actual(ownerId, command, definition, scope, guard);
      },
    );
    return seen;
  }

  it('整场最多三次生成，同话题换群也不新开，已加入的成员继续保留', async () => {
    await boot();
    const ids = [await companion('阿溪'), await companion('阿澜')];
    const path = await group(ids);
    const source = await publish(path, '聊一聊实际观察到的雨。');
    const seen = fixture(() => ({ kind: 'speak', text: '我观察到了雨。' }));
    await app.get(TaskWorkerService).start();
    const { session, turn } = await finish(path);
    expect(session).toMatchObject({
      triggerMessageId: source,
      calls: 3,
      maxCalls: 3,
      maxOutputTokens: 500,
      reason: 'peer_session_limit',
    });
    expect(turn.steps.map((step) => step.state)).toEqual(['spoken', 'spoken', 'spoken']);
    expect(seen).toEqual([500, 500, 500]);
    expect((await detail(path)).members.filter((member) => member.leftSequence !== null)).toEqual(
      [],
    );
    const repeated = await group(ids);
    await publish(repeated, '聊一聊实际观察到的雨。');
    const newer = await group(ids);
    await publish(newer, '新的真实话题，观察月亮。');
    await finish(newer);
    expect(await sessions(repeated)).toEqual([]);
    expect(await sessions(path)).toHaveLength(1);
  }, 45000);

  it('角色日额度先耗尽时保留已有发言和席位', async () => {
    await boot(4, 1);
    const path = await group([await companion('阿乙'), await companion('阿丙')]);
    await publish(path, '角色日额度验收。');
    fixture(() => ({ kind: 'speak', text: '第一条合法发言。' }));
    await app.get(TaskWorkerService).start();
    const { session, turn } = await finish(path);
    expect(session.calls).toBe(2);
    expect(turn.steps.map((step) => step.state)).toEqual([
      'spoken',
      'spoken',
      'skipped',
      'skipped',
    ]);
    expect((await detail(path)).members.filter((member) => member.leftSequence !== null)).toEqual(
      [],
    );
  }, 30000);

  it('只有公开对象可发现，伴侣实际接受邀约时建立独立会话', async () => {
    await boot();
    const sender = await companion('发起者');
    const receiver = await companion('接收者');
    await companion('未公开', false);
    const profiles = peerProfilesSchema.parse(
      (await owner.get('/api/peer-profiles').expect(200)).body.data,
    );
    expect(profiles.items.map(({ description }) => description).sort()).toEqual(
      ['发起者的公开简介。', '接收者的公开简介。'].sort(),
    );
    const chat = (
      await owner
        .post('/api/chats')
        .send({ requestId: randomUUID(), companionId: sender, runtimeEpoch: 1, title: '原有私聊' })
        .expect(201)
    ).body.data;
    const sent = await owner
      .post(`/api/chats/${chat.id}/messages`)
      .send({ requestId: randomUUID(), text: '这段原文只存在于私聊。' })
      .expect(201);
    const realMessage = sent.body.data.message.id as string;
    await owner
      .put(`/api/companions/${sender}/autonomy`)
      .send({
        conversationId: chat.id,
        runtimeEpoch: 1,
        requestId: randomUUID(),
        expectedVersion: 0,
        enabled: true,
        contactsEnabled: false,
      })
      .expect(200);
    fixture(() => ({ kind: 'silent', text: null }), receiver);
    await app.get(TaskWorkerService).start();
    const invitationId = await vi.waitFor(async () => {
      const response = await owner
        .get(`/api/companions/${sender}/autonomy/opportunities?runtimeEpoch=1`)
        .expect(200);
      const found = autonomyOpportunitiesSchema
        .parse(response.body.data)
        .items.find((item) => item.outcome === 'invitation');
      expect(found?.invitationId).toEqual(expect.any(String));
      return found!.invitationId;
    }, wait);
    const accepted = await vi.waitFor(async () => {
      const response = await owner.get(`/api/conversations/${chat.id}/invitations`).expect(200);
      const invitation = response.body.data.items.find(
        (item: { id: string }) => item.id === invitationId,
      );
      expect(invitation).toMatchObject({ state: 'accepted', decidedBy: 'companion' });
      return invitation.acceptedConversationId as string;
    }, wait);
    expect(accepted).not.toBe(chat.id);
    expect((await detail(`/api/conversations/${accepted}`)).conversation.kind).toBe('group');
    await owner.get(`/api/conversations/${accepted}/messages/${realMessage}`).expect(404);
  }, 40000);

  it('退出需要角色自己的实际交流和另一条可见依据', async () => {
    await boot(2);
    const leaving = await companion('离场者');
    const staying = await companion('留场者');
    const path = await group([leaving, staying]);
    const own = await publish(path, '我在以前明确告知想结束长期交流。', leaving);
    const other = await publish(path, '另一条已经发布的交流依据。', staying);
    fixture((actor) =>
      actor === leaving
        ? { kind: 'leave', text: null, evidenceMessageIds: [own, other] }
        : { kind: 'speak', text: '保留该会话。' },
    );
    await app.get(TaskWorkerService).start();
    const { turn } = await finish(path);
    expect(turn.steps.find((step) => step.companionId === leaving)?.state).toBe('left');
    expect(
      (await detail(path)).members.find((member) => member.companionId === leaving)?.leftSequence,
    ).not.toBeNull();
  }, 30000);
});
