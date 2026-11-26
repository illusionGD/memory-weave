import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  memoryConfigurationSchema,
  reflectionFindingListSchema,
  reflectionRunListSchema,
} from '@memory-weave/contracts';
import type { Message } from '@memory-weave/contracts';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app';
import { DatabaseService } from '../src/database/database.service';
import { reflectionRuns } from '../src/database/schema';
import { ModelRuntimeService } from '../src/modules/models/model-runtime.service';
import type { MemoryBatchInput } from '../src/modules/memories/memory-types';
import type { ReflectionInput } from '../src/modules/reflections/reflection-types';
import { TaskWorkerService } from '../src/modules/tasks/task-worker.service';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';
import { createTestAuthConfig, disposeTestAuth } from './support/redis';

afterAll(disposeTestAuth);

describe('F15 反思和自传公开协议', () => {
  let app: INestApplication;
  let database: TestDatabase;
  let directory: string;
  let agent: ReturnType<typeof request.agent>;
  let reflectionCalls: number;

  beforeEach(async () => {
    database = await createTestDatabase();
    directory = await mkdtemp(join(tmpdir(), 'memory-weave-reflections-'));
    app = await createApplication({
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      qdrantUrl: 'http://127.0.0.1:1',
      qdrantApiKey: 'isolated-vector-key',
      ...createTestAuthConfig(),
      adminPassword: 'reflection-test-password',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir: directory,
      webDistDir: null,
      memoryConfiguration: memoryConfigurationSchema.parse({ enabled: false }),
      reflectionConfiguration: {
        enabled: true,
        routineIntervalMs: 86400000,
        minimumIntervalMs: 60000,
        dailyRuns: 2,
        batchEvents: 6,
      },
    });
    agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: 'reflection-test-password' }).expect(200);
    reflectionCalls = 0;
  }, 30000);

  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
    await database?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30000);

  /** 固定模型候选但保留真实角色预算、调用结果与领域采用。 */
  function fixture() {
    const runtime = app.get(ModelRuntimeService);
    const actual = runtime.execute.bind(runtime);
    vi.spyOn(runtime, 'execute').mockImplementation(
      (ownerId, command, definition, scope, guard) => {
        if (command.role === 'memory') {
          const input = JSON.parse(command.inputText) as MemoryBatchInput;
          const source = input.messages.find(
            (item) =>
              item.target &&
              item.sourceKind === 'user_input' &&
              item.speaker.kind === 'user' &&
              item.text.includes('林雨'),
          );
          if (!source) return actual(ownerId, command, definition, scope, guard);
          const correction = source.text.includes('更正');
          const related = input.related.find((item) => item.document?.claim === 'experience');
          return actual(
            ownerId,
            command,
            {
              ...definition,
              testOutput: () => ({
                actions: [
                  {
                    action: correction ? 'revise' : 'add',
                    targetId: correction ? related?.id : null,
                    targetVersion: correction ? related?.version : null,
                    revisionKind: correction ? 'correction' : null,
                    document: {
                      kind: 'episodic',
                      claim: 'experience',
                      subject: { kind: 'user', name: null },
                      text: source.text,
                      reality: 'real',
                      storyKey: null,
                      epistemic: 'statement',
                      eventTime: null,
                      validFrom: null,
                      validUntil: null,
                    },
                    reason: '原文实际陈述。',
                    evidence: [
                      {
                        messageId: source.messageId,
                        contentVersion: source.contentVersion,
                        quote: source.text,
                      },
                    ],
                  },
                ],
              }),
            },
            scope,
            guard,
          );
        }
        if (command.role === 'reflection') {
          reflectionCalls++;
          const input = JSON.parse(command.inputText) as ReflectionInput;
          const event = input.events[0]!;
          const doc = {
            kind: event.kind === 'activity' ? 'autobiography' : 'belief',
            topic: event.kind === 'activity' ? 'draft' : 'send',
            disposition: 'adopt',
            account: event.kind === 'activity' ? '我完成了样稿。' : event.text,
            interpretation:
              event.kind === 'activity' ? '小镇样稿帮助我延续创作。' : '稿件交接需要核对接收者。',
            applicability: '只适用于这些已发生的工作。',
            uncertainty: null,
            evidence: [
              { eventId: event.eventId, role: 'support', excerpt: event.text.slice(0, 100) },
            ],
          };
          return actual(
            ownerId,
            command,
            {
              ...definition,
              testOutput: () => ({
                conclusion: '测试结论，已核对真实输入。',
                findings: [
                  doc,
                  {
                    ...doc,
                    topic: 'fabricated',
                    evidence: [{ ...doc.evidence[0], excerpt: '不存在的引文。' }],
                  },
                ],
              }),
            },
            scope,
            guard,
          );
        }
        return actual(ownerId, command, definition, scope, guard);
      },
    );
  }

  /** 通过公开入口创建真实伴侣与私聊范围。 */
  async function setup() {
    const companionId = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: '阿雨', initialProfile: '以实际经历为依据。' })
        .expect(201)
    ).body.data.id as string;
    const conversationId = (
      await agent
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          companionId,
          runtimeEpoch: 1,
          title: '反思场景',
        })
        .expect(201)
    ).body.data.id as string;
    return {
      companionId,
      scope: { conversationId, runtimeEpoch: 1 },
      path: `/api/companions/${companionId}/reflections`,
    };
  }

  /** 等待反思轮次写入实际采用结果。 */
  async function finished(path: string, scope: object, runId?: string) {
    return vi.waitFor(
      async () => {
        const response = await agent.get(path).query(scope).expect(200);
        const runs = reflectionRunListSchema.parse(response.body.data).items;
        const run = runs.find(
          (item) => item.status === 'succeeded' && (!runId || item.id === runId),
        );
        expect(run).toBeDefined();
        expect(run?.completedAt).toEqual(expect.any(String));
        return run!;
      },
      { timeout: 15000, interval: 100 },
    );
  }

  /** 从普通私聊写入原文并用公开入口安排整理。 */
  async function note(
    companionId: string,
    scope: { conversationId: string; runtimeEpoch: number },
    text: string,
  ): Promise<Message> {
    const message = (
      await agent
        .post(`/api/chats/${scope.conversationId}/messages`)
        .send({
          requestId: randomUUID(),
          text,
        })
        .expect(201)
    ).body.data.message;
    const queued = (
      await agent
        .post(`/api/companions/${companionId}/memories/organize`)
        .send({ requestId: randomUUID(), ...scope })
        .expect(201)
    ).body.data;
    await vi.waitFor(
      async () => {
        expect((await agent.get(`/api/tasks/${queued.taskId}`).expect(200)).body.data.status).toBe(
          'succeeded',
        );
      },
      { timeout: 15000, interval: 100 },
    );
    return message;
  }

  it('安静时不调用模型，完成的活动可形成自传，拒绝伪造引文并保存实际采用数量', async () => {
    fixture();
    const { companionId, scope, path } = await setup();
    const empty = await agent.post(`${path}/run`).send(scope).expect(200);
    expect(empty.body.data).toEqual({ state: 'no_meaningful_changes', runId: null });
    expect(reflectionCalls).toBe(0);
    const activity = (
      await agent
        .post('/api/activities')
        .send({
          ...scope,
          companionId,
          requestId: randomUUID(),
          specification: { kind: 'write', goal: '创作小镇样稿。' },
        })
        .expect(201)
    ).body.data;
    await app.get(TaskWorkerService).start();
    const run = await finished(path, scope);
    expect(run).toMatchObject({
      status: 'succeeded',
      mode: 'test',
      eventCount: 1,
      adopted: 1,
      rejected: 1,
    });
    const response = await agent.get(`${path}/findings`).query(scope).expect(200);
    const findings = reflectionFindingListSchema.parse(response.body.data).items;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'autobiography',
      status: 'current',
      evidence: [{ kind: 'activity', sourceId: activity.id, sourceVersion: 1 }],
    });
    expect((await agent.post(`${path}/run`).send(scope).expect(200)).body.data.state).toBe(
      'no_meaningful_changes',
    );
    expect(reflectionCalls).toBe(1);
    const sent = (
      await agent
        .post(`/api/chats/${scope.conversationId}/messages`)
        .send({
          requestId: randomUUID(),
          text: '说说小镇样稿。',
        })
        .expect(201)
    ).body.data.message;
    await vi.waitFor(
      async () => {
        const chat = (await agent.get(`/api/chats/${scope.conversationId}`).expect(200)).body.data;
        expect(chat.currentRun).toMatchObject({
          status: 'succeeded',
          triggerMessageId: sent.id,
          context: {
            reflections: [
              expect.objectContaining({ versionId: findings[0]!.versionId, kind: 'autobiography' }),
            ],
          },
        });
      },
      { timeout: 15000, interval: 100 },
    );
  }, 40000);

  it('更正即时停用旧认识，原文和版本可追溯，复核仍受持久额度限制', async () => {
    fixture();
    const { companionId, scope, path } = await setup();
    await app.get(TaskWorkerService).start();
    const source = await note(companionId, scope, '昨天把稿件发给林雨了。');
    const start = (await agent.post(`${path}/run`).send(scope).expect(200)).body.data;
    expect(start.state).toBe('queued');
    const first = await finished(path, scope, start.runId);
    const [prior] = (await agent.get(`${path}/findings`).query(scope).expect(200)).body.data.items;
    expect(prior).toMatchObject({
      kind: 'belief',
      status: 'current',
      version: 1,
      evidence: [{ excerpt: source.text }],
    });
    const correction = await note(companionId, scope, '更正：昨天没有把稿件发给林雨。');
    const withdrawn = (await agent.get(`${path}/findings`).query(scope).expect(200)).body.data
      .items;
    expect(withdrawn).toMatchObject([
      { id: prior.id, status: 'invalidated', document: null, evidence: [] },
    ]);
    expect((await agent.post(`${path}/run`).send(scope).expect(200)).body.data.state).toBe(
      'rate_limited',
    );
    expect(reflectionCalls).toBe(1);
    await app
      .get(DatabaseService)
      .sql.update(reflectionRuns)
      .set({ createdAt: new Date(Date.now() - 65000) })
      .where(and(eq(reflectionRuns.ownerId, source.ownerId), eq(reflectionRuns.id, first.id)));
    const next = await vi.waitFor(
      async () => {
        const response = await agent.get(path).query(scope).expect(200);
        const completed = response.body.data.items.find(
          (run: { id: string; status: string }) =>
            run.id !== first.id && run.status === 'succeeded',
        );
        expect(completed).toBeDefined();
        return completed;
      },
      { timeout: 15000, interval: 100 },
    );
    expect(next.adopted).toBe(1);
    const [newest, old] = (await agent.get(`${path}/findings/${prior.id}/versions`).expect(200))
      .body.data.items;
    expect(newest).toMatchObject({
      version: 2,
      status: 'current',
      evidence: [{ excerpt: correction.text }],
    });
    expect(old).toMatchObject({ version: 1, status: 'invalidated', document: null });
    await app.get(TaskWorkerService).stop();
    const conversation = (await agent.get(`/api/conversations/${scope.conversationId}`).expect(200))
      .body.data.conversation;
    const operation = (
      await agent
        .post('/api/lifecycle')
        .send({
          requestId: randomUUID(),
          kind: 'delete_messages',
          conversationId: scope.conversationId,
          expectedVersion: conversation.version,
          messages: [{ messageId: correction.id, contentVersion: correction.contentVersion }],
        })
        .expect(201)
    ).body.data;
    await app.get(TaskWorkerService).start();
    await vi.waitFor(
      async () => {
        expect(
          (await agent.get(`/api/lifecycle/${operation.id}`).expect(200)).body.data.completedAt,
        ).toEqual(expect.any(String));
      },
      { timeout: 15000, interval: 100 },
    );
    const history = (await agent.get(`${path}/findings/${prior.id}/versions`).expect(200)).body.data
      .items;
    expect(history[0]).toMatchObject({ status: 'invalidated', document: null, evidence: [] });
  }, 45000);
});
