import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { memoryConfigurationSchema, relationshipListSchema } from '@memory-weave/contracts';
import type { ConversationDetail, Message } from '@memory-weave/contracts';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app';
import { DatabaseService } from '../src/database/database.service';
import { relationshipVersions } from '../src/database/schema';
import { ModelRuntimeService } from '../src/modules/models/model-runtime.service';
import { TaskWorkerService } from '../src/modules/tasks/task-worker.service';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';
import { createTestAuthConfig, disposeTestAuth } from './support/redis';

afterAll(disposeTestAuth);

type Source = {
  messageId: string;
  contentVersion: number;
  text: string;
  speakerMembershipId: string;
  target: boolean;
};
type CandidateInput = {
  self: string;
  participants: { id: string; kind: string }[];
  sources: Source[];
};

describe('F14 关系与感受公开协议', () => {
  let app: INestApplication;
  let database: TestDatabase;
  let dataDir: string;
  let agent: ReturnType<typeof request.agent>;
  let relationshipCalls: number;

  beforeEach(async () => {
    database = await createTestDatabase();
    dataDir = await mkdtemp(join(tmpdir(), 'memory-weave-relationships-'));
    app = await createApplication({
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      qdrantUrl: 'http://127.0.0.1:1',
      qdrantApiKey: 'isolated-vector-key',
      ...createTestAuthConfig(),
      adminPassword: 'relationship-test-password',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir,
      webDistDir: null,
      memoryConfiguration: memoryConfigurationSchema.parse({ enabled: false }),
    });
    agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/auth/login')
      .send({ password: 'relationship-test-password' })
      .expect(200);
    relationshipCalls = 0;
  }, 30000);

  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
    await database?.dispose();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }, 30000);

  /** 给确定性 adapter 提供候选，保留真实任务、模型调度和采用路径。 */
  function useFixture(propose: (input: CandidateInput, companionId: string) => unknown): void {
    const runtime = app.get(ModelRuntimeService);
    const actual = runtime.execute.bind(runtime);
    vi.spyOn(runtime, 'execute').mockImplementation(
      (ownerId, command, definition, scope, guard) => {
        if (command.role === 'memory') {
          const input = JSON.parse(command.inputText) as { messages: Source[] };
          const source = input.messages.find((item) => item.target && item.text.includes('先听完'));
          return actual(
            ownerId,
            command,
            {
              ...definition,
              testOutput: () => ({
                actions: source
                  ? [
                      {
                        action: 'add',
                        targetId: null,
                        targetVersion: null,
                        revisionKind: null,
                        document: {
                          kind: 'relational',
                          claim: 'preference',
                          subject: { kind: 'user', name: null },
                          text: '对方表达希望先听完。',
                          reality: 'real',
                          storyKey: null,
                          epistemic: 'statement',
                          eventTime: null,
                          validFrom: null,
                          validUntil: null,
                        },
                        reason: '实际表达。',
                        evidence: [
                          {
                            messageId: source.messageId,
                            contentVersion: source.contentVersion,
                            quote: source.text,
                          },
                        ],
                      },
                    ]
                  : [],
              }),
            },
            scope,
            guard,
          );
        }
        if (command.role === 'relationship') {
          relationshipCalls++;
          const input = JSON.parse(command.inputText) as CandidateInput;
          return actual(
            ownerId,
            command,
            {
              ...definition,
              testOutput: () => propose(input, scope!.companionId!),
            },
            scope,
            guard,
          );
        }
        return actual(ownerId, command, definition, scope, guard);
      },
    );
  }

  /** 创建独立伴侣。 */
  async function companion(name: string): Promise<string> {
    return (
      await agent
        .post('/api/companions')
        .send({
          requestId: randomUUID(),
          name,
          initialProfile: '尊重实际双方的表达。',
        })
        .expect(201)
    ).body.data.id;
  }

  /** 保存并发布确切的会话原文。 */
  async function publish(
    conversationId: string,
    text: string,
    speaker: object = { kind: 'user' },
  ): Promise<Message> {
    const version = (await details(conversationId)).conversation.version;
    const draft = (
      await agent
        .post(`/api/conversations/${conversationId}/messages`)
        .send({
          requestId: randomUUID(),
          expectedConversationVersion: version,
          speaker,
          text,
          reality: 'real',
        })
        .expect(201)
    ).body.data;
    return (
      await agent
        .post(`/api/conversations/${conversationId}/messages/${draft.id}/publish`)
        .send({
          requestId: randomUUID(),
          expectedConversationVersion: version,
          expectedRevision: draft.revision,
        })
        .expect(201)
    ).body.data;
  }

  /** 查询会话真实成员与写入版本。 */
  async function details(id: string): Promise<ConversationDetail> {
    return (await agent.get(`/api/conversations/${id}`).expect(200)).body.data;
  }

  /** 用已有整理入口提前处理一批确切原文。 */
  async function organize(companionId: string, conversationId: string): Promise<void> {
    const queued = (
      await agent
        .post(`/api/companions/${companionId}/memories/organize`)
        .send({
          requestId: randomUUID(),
          runtimeEpoch: 1,
          conversationId,
        })
        .expect(201)
    ).body.data;
    await vi.waitFor(
      async () => {
        expect((await agent.get(`/api/tasks/${queued.taskId}`).expect(200)).body.data.status).toBe(
          'succeeded',
        );
      },
      { timeout: 13000, interval: 100 },
    );
  }

  /** 查询某个实例在指定会话中的状态。 */
  async function state(companionId: string, conversationId: string) {
    const result = await agent
      .get(`/api/companions/${companionId}/relationships`)
      .query({
        runtimeEpoch: 1,
        conversationId,
      })
      .expect(200);
    return relationshipListSchema.parse(result.body.data).items;
  }

  /** 从模型实际接收的输入回填测试候选的引文。 */
  function evidence(source: Source) {
    return {
      messageId: source.messageId,
      contentVersion: source.contentVersion,
      quote: source.text,
    };
  }

  it('用户偏好和短期感受分开，单方面表达不能成为约定，清理后撤回聊天派生结果', async () => {
    const a = await companion('阿澜');
    const chat = (
      await agent
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          companionId: a,
          runtimeEpoch: 1,
          title: '关系验收',
        })
        .expect(201)
    ).body.data;
    const id = chat.id;
    useFixture((input) => {
      const user = input.participants.find((item) => item.kind === 'user')!;
      const source = input.sources.find(
        (item) => item.target && item.speakerMembershipId === user.id,
      )!;
      return {
        updates: [
          {
            kind: 'other_preference',
            counterpartMembershipId: user.id,
            topic: 'listening',
            description: '用户希望先听完整经过。',
            reason: '用户明确表达。',
            provenance: 'expression',
            evidence: [evidence(source)],
          },
          {
            kind: 'observed_emotion',
            counterpartMembershipId: user.id,
            topic: 'current',
            description: '用户表示此刻有些难过。',
            reason: '用户明确表达。',
            provenance: 'expression',
            evidence: [evidence(source)],
          },
          {
            kind: 'agreement',
            counterpartMembershipId: user.id,
            topic: 'listening',
            description: '我们已经约定。',
            reason: '单方要求。',
            provenance: 'mutual',
            evidence: [evidence(source)],
          },
        ],
      };
    });
    await app.get(TaskWorkerService).start();
    const send = async (text: string): Promise<Message> =>
      (
        await agent
          .post(`/api/chats/${id}/messages`)
          .send({ requestId: randomUUID(), text })
          .expect(201)
      ).body.data.message;
    await send('今天天气不错。');
    await organize(a, id);
    expect(relationshipCalls).toBe(0);
    const source = await send('今天很难过，我希望你先听完。');
    await organize(a, id);
    const established = await vi.waitFor(
      async () => {
        const items = await state(a, id);
        expect(items).toHaveLength(2);
        return items;
      },
      { timeout: 12000, interval: 100 },
    );
    const observed = established.find((item) => item.kind === 'observed_emotion')!;
    expect(observed).toMatchObject({
      status: 'current',
      mode: 'test',
      expiresAt: expect.any(String),
    });
    expect(established.find((item) => item.kind === 'other_preference')).toMatchObject({
      document: { provenance: 'expression' },
      evidence: [{ messageId: source.id }],
      expiresAt: null,
    });
    await agent
      .post(`/api/chats/${id}/messages`)
      .send({ requestId: randomUUID(), text: '我们继续聊。' })
      .expect(201);
    const run = await vi.waitFor(
      async () => {
        const view = (await agent.get(`/api/chats/${id}`).expect(200)).body.data.currentRun;
        expect(view.status).toBe('succeeded');
        return view;
      },
      { timeout: 12000, interval: 100 },
    );
    expect(run.context.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'other_preference',
          sources: expect.arrayContaining([
            { messageId: source.id, contentVersion: source.contentVersion },
          ]),
        }),
      ]),
    );
    await app
      .get(DatabaseService)
      .sql.update(relationshipVersions)
      .set({ expiresAt: new Date(0) })
      .where(
        and(
          eq(relationshipVersions.ownerId, source.ownerId),
          eq(relationshipVersions.stateId, observed.id),
        ),
      );
    expect((await state(a, id)).find((item) => item.id === observed.id)).toMatchObject({
      status: 'expired',
      document: null,
      evidence: [],
    });
    const version = (await details(id)).conversation.version;
    const operation = (
      await agent
        .post('/api/lifecycle')
        .send({
          requestId: randomUUID(),
          kind: 'delete_messages',
          conversationId: id,
          expectedVersion: version,
          messages: [{ messageId: source.id, contentVersion: source.contentVersion }],
        })
        .expect(201)
    ).body.data;
    await vi.waitFor(
      async () => {
        const result = (await agent.get(`/api/lifecycle/${operation.id}`).expect(200)).body.data;
        expect(result.completedAt).toEqual(expect.any(String));
      },
      { timeout: 14000, interval: 100 },
    );
    expect(await state(a, id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: observed.id,
          status: 'invalidated',
          topic: 'redacted',
          document: null,
          evidence: [],
        }),
      ]),
    );
  }, 40000);

  it('同一群聊保留 A 对 B 和 B 对 A 的不同认识，只有双方原文支持的约定才采用', async () => {
    const a = await companion('阿澜');
    const b = await companion('阿溪');
    const response = await agent
      .post('/api/conversations')
      .send({
        requestId: randomUUID(),
        title: '同伴关系验收',
        kind: 'group',
        includeUser: true,
        companions: [a, b].map((companionId) => ({ companionId, runtimeEpoch: 1 })),
      })
      .expect(201);
    const group: ConversationDetail = response.body.data;
    const id = group.conversation.id;
    await publish(id, '我同意听完你的故事。', {
      kind: 'companion',
      companionId: a,
      runtimeEpoch: 1,
    });
    await publish(id, '我也同意先互相听完。', {
      kind: 'companion',
      companionId: b,
      runtimeEpoch: 1,
    });
    await publish(id, '我希望大家先听完。');
    useFixture((input, companionId) => {
      const other = input.participants.find((item) => item.kind === 'companion')!;
      const selfSource = input.sources.find((item) => item.speakerMembershipId === input.self)!;
      const otherSource = input.sources.find((item) => item.speakerMembershipId === other.id)!;
      return {
        updates: [
          {
            kind: 'agreement',
            topic: 'hear-story',
            counterpartMembershipId: other.id,
            description: companionId === a ? '阿澜理解为先听完整故事。' : '阿溪理解为互相听完。',
            reason: '双方表达同意。',
            provenance: 'mutual',
            evidence: [evidence(selfSource), evidence(otherSource)],
          },
          {
            kind: 'observed_emotion',
            topic: 'current',
            counterpartMembershipId: other.id,
            description: '无证据候选。',
            reason: '引文缺失。',
            provenance: 'inference',
            evidence: [{ ...evidence(otherSource), quote: '没有出现在原文。' }],
          },
        ],
      };
    });
    await app.get(TaskWorkerService).start();
    await organize(a, id);
    await organize(b, id);
    const [fromA, fromB] = await vi.waitFor(
      async () => {
        const forA = await state(a, id);
        const forB = await state(b, id);
        expect(forA).toHaveLength(1);
        expect(forB).toHaveLength(1);
        return [forA[0]!, forB[0]!] as const;
      },
      { timeout: 15000, interval: 100 },
    );
    expect(fromA).toMatchObject({
      kind: 'agreement',
      document: { description: '阿澜理解为先听完整故事。', provenance: 'mutual' },
    });
    expect(fromB).toMatchObject({
      kind: 'agreement',
      document: { description: '阿溪理解为互相听完。', provenance: 'mutual' },
    });
    expect(fromA.counterpartMembershipId).not.toBe(fromB.counterpartMembershipId);
    expect(fromA.evidence).toHaveLength(2);
    expect(new Set(fromA.evidence.map((entry) => entry.speakerMembershipId)).size).toBe(2);
    await agent.get(`/api/companions/${b}/relationships/${fromA.id}/versions`).expect(404);
    expect(
      (await agent.get(`/api/companions/${a}/relationships/${fromA.id}/versions`).expect(200)).body
        .data.items,
    ).toMatchObject([{ id: fromA.id, version: 1 }]);
  }, 40000);
});
