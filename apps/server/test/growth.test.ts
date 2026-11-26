import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  companionDetailSchema,
  growthCandidatesSchema,
  personaVersionSchema,
} from '@memory-weave/contracts';
import type { GrowthCandidate, PersonaVersion } from '@memory-weave/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app';
import { ModelRuntimeService } from '../src/modules/models/model-runtime.service';
import type { ReflectionInput } from '../src/modules/reflections/reflection-types';
import { TaskWorkerService } from '../src/modules/tasks/task-worker.service';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';
import { createTestAuthConfig, disposeTestAuth } from './support/redis';

afterAll(disposeTestAuth);

interface GrowthInput {
  currentPersona: PersonaVersion['document'];
  evidence: ReflectionInput['events'];
  candidate?: { supportEventIds: string[] };
}

describe('F16 成长候选、验证与回退', () => {
  let app: INestApplication;
  let database: TestDatabase;
  let directory: string;
  let agent: ReturnType<typeof request.agent>;
  let used: { role: string; id: string; input: GrowthInput }[];

  beforeEach(async () => {
    database = await createTestDatabase();
    directory = await mkdtemp(join(tmpdir(), 'memory-weave-growth-'));
    app = await createApplication({
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      qdrantUrl: 'http://127.0.0.1:1',
      qdrantApiKey: 'isolated-vector-key',
      ...createTestAuthConfig(),
      adminPassword: 'growth-test-password',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir: directory,
      webDistDir: null,
      reflectionConfiguration: {
        enabled: true,
        routineIntervalMs: 1000,
        minimumIntervalMs: 1000,
        dailyRuns: 8,
        batchEvents: 6,
      },
      growthConfiguration: { enabled: true, minimumAdoptionIntervalMs: 1000 },
    });
    agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: 'growth-test-password' }).expect(200);
    used = [];
  }, 30000);

  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
    await database?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30000);

  /** 用确定性候选驱动真实反思、角色预算和追加验证。 */
  function install(
    options: { reject?: boolean; validationBarrier?: () => Promise<void> } = {},
  ): void {
    const runtime = app.get(ModelRuntimeService);
    const execute = runtime.execute.bind(runtime);
    vi.spyOn(runtime, 'execute').mockImplementation(
      async (ownerId, command, definition, scope, guard) => {
        if (command.role === 'persona') {
          return execute(
            ownerId,
            command,
            {
              ...definition,
              testOutput: () => ({
                name: '阿澜',
                core: [{ text: '记录小镇故事。', evidence: '记录小镇故事' }],
                inclinations: [{ text: '喜欢慢慢观察。', evidence: '喜欢慢慢观察' }],
                knowledge: [],
                lockedQuotes: [],
              }),
            },
            scope,
            guard,
          );
        }
        if (command.role === 'reflection') {
          const input = JSON.parse(command.inputText) as ReflectionInput;
          const first = input.events[0]!;
          return execute(
            ownerId,
            command,
            {
              ...definition,
              testOutput: () => ({
                conclusion: '测试反思保留已完成的实际创作。',
                findings: [
                  {
                    kind: 'autobiography',
                    topic: 'actual-draft',
                    disposition: 'adopt',
                    account: '完成了一次短篇写作。',
                    interpretation: '在具体任务中体会创作。',
                    applicability: '已完成的作品。',
                    uncertainty: null,
                    evidence: [
                      { eventId: first.eventId, role: 'support', excerpt: first.text.slice(0, 90) },
                    ],
                  },
                ],
              }),
            },
            scope,
            guard,
          );
        }
        if (command.role === 'growth' || command.role === 'growth_validation') {
          const input = JSON.parse(command.inputText) as GrowthInput;
          used.push({ role: command.role, id: command.requestId, input });
          if (command.role === 'growth') {
            return execute(
              ownerId,
              command,
              {
                ...definition,
                testOutput: () => ({
                  proposal: {
                    topic: 'town-stories',
                    dimension: 'interest',
                    text: '喜欢尝试短篇人物描写。',
                    applicability: '自己选择短篇写作题材时。',
                    reason: '两次独立创作后发现愿意继续。',
                    supportEventIds: input.evidence.map((source) => source.eventId),
                    counterexampleEventIds: [],
                  },
                }),
              },
              scope,
              guard,
            );
          }
          const call = await execute(
            ownerId,
            command,
            {
              ...definition,
              testOutput: () => ({
                accept: true,
                evidenceSufficient: true,
                localChange: true,
                preservesLocks: !options.reject,
                reason: options.reject ? '独立验证发现与锁定范围冲突。' : '局部变化，证据独立。',
              }),
            },
            scope,
            guard,
          );
          await options.validationBarrier?.();
          return call;
        }
        return execute(ownerId, command, definition, scope, guard);
      },
    );
  }

  /** 走公开 M01 创建与私聊路径读取初始不可变人格。 */
  async function setup() {
    const created = (
      await agent
        .post('/api/companion-creations')
        .send({
          requestId: randomUUID(),
          name: '阿澜',
          source: {
            kind: 'text',
            profileText: '阿澜记录小镇故事，喜欢慢慢观察。',
            lockedFeatures: ['保留独立思考'],
          },
        })
        .expect(201)
    ).body.data;
    const companionId = created.companion.id as string;
    await app.get(TaskWorkerService).start();
    const initial = await vi.waitFor(
      async () => {
        const record = await agent.get(`/api/companions/${companionId}`).expect(200);
        const companion = companionDetailSchema.parse(record.body.data);
        expect(companion.currentPersonaVersion.origin).toBe('initialization');
        return companion.currentPersonaVersion;
      },
      { timeout: 15000, interval: 100 },
    );
    const chat = (
      await agent
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          companionId,
          runtimeEpoch: 1,
          title: '成长验收',
        })
        .expect(201)
    ).body.data;
    const scope = { companionId, runtimeEpoch: 1, conversationId: chat.id as string };
    return { scope, initial, path: `/api/companions/${companionId}/growth` };
  }

  /** 提交两份相互独立的实际委托，其中一份绑定确切的交流来源。 */
  async function prepare(scope: {
    companionId: string;
    runtimeEpoch: number;
    conversationId: string;
  }) {
    const message = (
      await agent
        .post(`/api/chats/${scope.conversationId}/messages`)
        .send({
          requestId: randomUUID(),
          text: '短篇参考：晚归的旅客。',
        })
        .expect(201)
    ).body.data.message;
    await agent
      .post('/api/activities')
      .send({
        ...scope,
        requestId: randomUUID(),
        specification: {
          kind: 'write',
          goal: '描写晚归旅客。',
          source: { messageId: message.id, contentVersion: message.contentVersion },
        },
      })
      .expect(201);
    await agent
      .post('/api/activities')
      .send({
        ...scope,
        requestId: randomUUID(),
        specification: { kind: 'write', goal: '另写一段清晨街景。' },
      })
      .expect(201);
    return message;
  }

  /** 按候选实际状态等待运行结束。 */
  async function candidate(
    path: string,
    status: GrowthCandidate['status'],
  ): Promise<GrowthCandidate> {
    return vi.waitFor(
      async () => {
        const response = await agent.get(`${path}/candidates?runtimeEpoch=1`).expect(200);
        const items = growthCandidatesSchema.parse(response.body.data).items;
        const item = items.find((record) => record.status === status);
        expect(item).toBeDefined();
        return item!;
      },
      { timeout: 27000, interval: 100 },
    );
  }

  it('从独立真实经历生成并验证后自动提交，清理来源及回退保持当前锁定', async () => {
    install();
    const { scope, initial, path } = await setup();
    const message = await prepare(scope);
    const result = await candidate(path, 'adopted');
    expect(used.map((entry) => entry.role)).toEqual(['growth', 'growth_validation']);
    expect(used[1]!.id).not.toBe(used[0]!.id);
    expect(used[1]!.input).toMatchObject({
      currentPersona: { locks: [{ text: '保留独立思考' }] },
      candidate: {
        supportEventIds: expect.arrayContaining(
          used[0]!.input.evidence.map((source) => source.eventId),
        ),
      },
    });
    expect(new Set(used[1]!.input.evidence.map((entry) => entry.sourceId)).size).toBe(2);
    const companionPath = `/api/companions/${scope.companionId}`;
    const current = companionDetailSchema.parse(
      (await agent.get(companionPath).expect(200)).body.data,
    ).currentPersonaVersion;
    expect(current).toMatchObject({
      id: result.adoptedPersonaVersionId,
      origin: 'growth',
      parentVersionId: initial.id,
      document: {
        name: initial.document?.name,
        core: initial.document?.core,
        locks: initial.document?.locks,
        growth: [{ growthId: result.id, topic: 'town-stories' }],
      },
    });
    const revised = personaVersionSchema.parse(
      (
        await agent
          .post(`${companionPath}/persona/locks`)
          .send({
            requestId: randomUUID(),
            runtimeEpoch: 1,
            expectedPersonaVersion: current.version,
            lockedFeatures: ['保留独立思考', '保留表达清晰'],
          })
          .expect(201)
      ).body.data,
    );
    const rollback = {
      requestId: randomUUID(),
      runtimeEpoch: 1,
      expectedPersonaVersionId: revised.id,
      targetPersonaVersionId: initial.id,
    };
    const resultVersion = personaVersionSchema.parse(
      (await agent.post(`${path}/rollback`).send(rollback).expect(200)).body.data,
    );
    expect(resultVersion).toMatchObject({
      origin: 'growth_rollback',
      version: revised.version + 1,
      document: { growth: [], locks: revised.document?.locks },
    });
    expect((await agent.post(`${path}/rollback`).send(rollback).expect(200)).body.data.id).toBe(
      resultVersion.id,
    );
    await agent
      .post(`${path}/rollback`)
      .send({
        ...rollback,
        requestId: randomUUID(),
        expectedPersonaVersionId: resultVersion.id,
        targetPersonaVersionId: current.id,
      })
      .expect(409);

    const conversationPath = `/api/conversations/${scope.conversationId}`;
    const conversation = (await agent.get(conversationPath).expect(200)).body.data.conversation;
    const operation = (
      await agent
        .post('/api/lifecycle')
        .send({
          requestId: randomUUID(),
          kind: 'delete_messages',
          conversationId: scope.conversationId,
          expectedVersion: conversation.version,
          messages: [{ messageId: message.id, contentVersion: message.contentVersion }],
        })
        .expect(201)
    ).body.data;
    await vi.waitFor(
      async () => {
        expect(
          (await agent.get(`/api/lifecycle/${operation.id}`).expect(200)).body.data.status,
        ).toBe('completed');
      },
      { timeout: 15000, interval: 100 },
    );
    expect(await candidate(path, 'invalidated')).toMatchObject({
      proposal: null,
      validation: null,
    });
    expect(
      (
        await agent
          .get(`${companionPath}/persona/versions/${current.version}?runtimeEpoch=1`)
          .expect(200)
      ).body.data.document.growth,
    ).toEqual([]);

    const details = companionDetailSchema.parse(
      (await agent.get(companionPath).expect(200)).body.data,
    );
    const reset = (
      await agent
        .post('/api/lifecycle')
        .send({
          requestId: randomUUID(),
          kind: 'reset_companion',
          companionId: scope.companionId,
          runtimeEpoch: 1,
          expectedVersion: details.version,
        })
        .expect(201)
    ).body.data;
    await vi.waitFor(
      async () => {
        expect((await agent.get(`/api/lifecycle/${reset.id}`).expect(200)).body.data.status).toBe(
          'completed',
        );
      },
      { timeout: 15000, interval: 100 },
    );
    const after = companionDetailSchema.parse(
      (await agent.get(companionPath).expect(200)).body.data,
    );
    await agent
      .post(`${path}/rollback`)
      .send({
        requestId: randomUUID(),
        runtimeEpoch: 2,
        expectedPersonaVersionId: after.currentPersonaVersionId,
        targetPersonaVersionId: current.id,
      })
      .expect(404);
  }, 65000);

  it('追加验证拒绝违反锁定的候选，即使模型同时给出接受结论', async () => {
    install({ reject: true });
    const { scope, initial, path } = await setup();
    await prepare(scope);
    expect(await candidate(path, 'rejected')).toMatchObject({
      reason: 'growth_validation_rejected',
      validation: { accept: true, preservesLocks: false },
      adoptedPersonaVersionId: null,
    });
    expect(
      (await agent.get(`/api/companions/${scope.companionId}`).expect(200)).body.data
        .currentPersonaVersionId,
    ).toBe(initial.id);
  }, 45000);

  it('冻结控制持久化，拒绝冻结前已发出的验证结果', async () => {
    let entered = false;
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    install({
      validationBarrier: async () => {
        entered = true;
        await barrier;
      },
    });
    const { scope, initial, path } = await setup();
    try {
      await prepare(scope);
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 27000, interval: 100 });
      const command = {
        runtimeEpoch: 1,
        expectedVersion: 0,
        requestId: randomUUID(),
        frozen: true,
      };
      const freeze = (await agent.post(`${path}/freeze`).send(command).expect(200)).body.data;
      expect(freeze).toEqual({ runtimeEpoch: 1, version: 1, frozen: true });
      expect((await agent.post(`${path}/freeze`).send(command).expect(200)).body.data).toEqual(
        freeze,
      );
      await agent
        .post(`${path}/freeze`)
        .send({ ...command, requestId: randomUUID(), frozen: false })
        .expect(409);
    } finally {
      release();
    }
    expect(await candidate(path, 'observing')).toMatchObject({ adoptedPersonaVersionId: null });
    expect((await agent.get(`${path}/control?runtimeEpoch=1`).expect(200)).body.data.frozen).toBe(
      true,
    );
    expect(
      (await agent.get(`/api/companions/${scope.companionId}`).expect(200)).body.data
        .currentPersonaVersionId,
    ).toBe(initial.id);
  }, 45000);
});
