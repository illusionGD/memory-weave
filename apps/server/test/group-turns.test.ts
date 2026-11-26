import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  conversationDetailSchema,
  createdGroupTurnSchema,
  groupTurnSchema,
} from '@memory-weave/contracts';
import type { GroupTurnRequest } from '@memory-weave/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app';
import { ModelRuntimeService } from '../src/modules/models/model-runtime.service';
import { TaskWorkerService } from '../src/modules/tasks/task-worker.service';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';
import { createTestAuthConfig, disposeTestAuth } from './support/redis';

afterAll(disposeTestAuth);

interface GroupInput {
  group: { self: { membershipId: string; name: string; originalProfile: string }; step: number };
  messages: { sequence: number; text: string; membershipId: string }[];
}

describe('F18 多参与者顺序接话', () => {
  let app: INestApplication;
  let database: TestDatabase;
  let directory: string;
  let owner: ReturnType<typeof request.agent>;
  let inputs: GroupInput[];

  beforeEach(async () => {
    database = await createTestDatabase();
    directory = await mkdtemp(join(tmpdir(), 'memory-weave-group-turns-'));
    app = await createApplication({
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      qdrantUrl: 'http://127.0.0.1:1',
      qdrantApiKey: 'isolated-vector-key',
      ...createTestAuthConfig(),
      adminPassword: 'group-turn-test-password',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir: directory,
      webDistDir: null,
    });
    owner = request.agent(app.getHttpServer());
    await owner.post('/api/auth/login').send({ password: 'group-turn-test-password' }).expect(200);
    inputs = [];
  }, 30000);

  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
    await database?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30000);

  /** 将接话候选交给真实模型和任务路径，允许在已生成未发布处控制时序。 */
  function fixture(
    options: { silent?: string; beforeReturn?: (input: GroupInput) => Promise<void> } = {},
  ) {
    const runtime = app.get(ModelRuntimeService);
    const actual = runtime.execute.bind(runtime);
    vi.spyOn(runtime, 'execute').mockImplementation(
      async (ownerId, command, definition, scope, guard) => {
        if (command.role !== 'chat' || command.operation !== 'structured')
          return actual(ownerId, command, definition, scope, guard);
        const input = JSON.parse(command.inputText) as GroupInput;
        inputs.push(input);
        const { name } = input.group.self;
        const call = await actual(
          ownerId,
          command,
          {
            ...definition,
            testOutput: () =>
              name === options.silent
                ? { kind: 'silent', text: null }
                : { kind: 'speak', text: `已发布的测试意见：${name}，第${input.group.step}位。` },
          },
          scope,
          guard,
        );
        await options.beforeReturn?.(input);
        return call;
      },
    );
  }

  /** 创建不同的人格和一个真实共享会话。 */
  async function group() {
    const ids: string[] = [];
    for (const name of ['阿澜', '阿溪', '小雨'])
      ids.push(
        (
          await owner
            .post('/api/companions')
            .send({
              requestId: randomUUID(),
              name,
              initialProfile: `${name}的独立初始设定。`,
            })
            .expect(201)
        ).body.data.id,
      );
    const response = await owner
      .post('/api/conversations')
      .send({
        requestId: randomUUID(),
        kind: 'group',
        title: '接话验收',
        includeUser: true,
        companions: ids.slice(0, 2).map((companionId) => ({ companionId, runtimeEpoch: 1 })),
      })
      .expect(201);
    const conversationId = conversationDetailSchema.parse(response.body.data).conversation.id;
    return { ids, conversationId, path: `/api/conversations/${conversationId}` };
  }

  /** 读取会话真实当前成员和版本。 */
  async function detail(path: string) {
    return conversationDetailSchema.parse((await owner.get(path).expect(200)).body.data);
  }

  /** 用通用发布入口补充消息。 */
  async function publish(path: string, text: string) {
    const { version } = (await detail(path)).conversation;
    const draft = (
      await owner
        .post(`${path}/messages`)
        .send({
          requestId: randomUUID(),
          speaker: { kind: 'user' },
          expectedConversationVersion: version,
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
          expectedConversationVersion: version,
        })
        .expect(201)
    ).body.data;
  }

  /** 发送群聊并核对同一命令不会发布两条触发消息。 */
  async function send(path: string, text: string, addressing: GroupTurnRequest['addressing']) {
    const expectedConversationVersion = (await detail(path)).conversation.version;
    const command = { requestId: randomUUID(), expectedConversationVersion, text, addressing };
    const initial = createdGroupTurnSchema.parse(
      (await owner.post(`${path}/turns`).send(command).expect(201)).body.data,
    );
    const replay = createdGroupTurnSchema.parse(
      (await owner.post(`${path}/turns`).send(command).expect(201)).body.data,
    );
    expect(replay.turn.id).toBe(initial.turn.id);
    expect(replay.message.id).toBe(initial.message.id);
    return initial;
  }

  /** 回查实际任务成功和各个发言状态。 */
  async function success(path: string, turnId: string) {
    return vi.waitFor(
      async () => {
        const row = groupTurnSchema.parse(
          (await owner.get(`${path}/turns/${turnId}`).expect(200)).body.data,
        );
        expect(row.task.status, row.task.reason ?? '').toBe('succeeded');
        return row;
      },
      { timeout: 18000, interval: 100 },
    );
  }

  it('按指定顺序使用每位伴侣自己的可见历史，后续成员基于已发布内容接话', async () => {
    fixture({ silent: '阿溪' });
    const { ids, path } = await group();
    await publish(path, '新成员不可见的旧消息。');
    const invite = (
      await owner
        .post(`${path}/invitations`)
        .send({
          requestId: randomUUID(),
          expectedConversationVersion: 2,
          companionId: ids[2],
          runtimeEpoch: 1,
        })
        .expect(201)
    ).body.data;
    await owner
      .post(`${path}/invitations/${invite.id}/decision`)
      .send({
        requestId: randomUUID(),
        expectedVersion: 1,
        decision: 'accept',
      })
      .expect(200);
    const members = (await detail(path)).members;
    const ordered = [ids[0], ids[2], ids[1]].map(
      (id) => members.find((member) => member.companionId === id)!.id,
    );
    expect((await owner.get(`${path}/turns`).expect(200)).body.data.items).toEqual([]);
    const started = await send(path, '请分别给出意见。', { mode: 'each', membershipIds: ordered });
    await app.get(TaskWorkerService).start();
    const done = await success(path, started.turn.id);
    expect(done.steps.map((step) => step.state)).toEqual(['spoken', 'spoken', 'silent']);
    expect(inputs.map((entry) => entry.group.self.name)).toEqual(['阿澜', '小雨', '阿溪']);
    expect(inputs[1]!.group.self.originalProfile).toBe('小雨的独立初始设定。');
    expect(inputs[1]!.messages.map(({ text }) => text)).toEqual([
      '请分别给出意见。',
      '已发布的测试意见：阿澜，第1位。',
    ]);
    expect(inputs[2]!.messages.at(-1)?.text).toBe('已发布的测试意见：小雨，第2位。');
    expect(
      (await owner.get(`${path}/messages`).expect(200)).body.data.items.map(
        (row: { sequence: number }) => row.sequence,
      ),
    ).toEqual([1, 2, 3, 4]);
    await owner.get(`${path}/turns`).expect(200);
    expect(inputs).toHaveLength(3);
  }, 40000);

  it('普通发布的用户插话废止在途结果，保留已发布的那一段并可重新点名', async () => {
    let held = false;
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture({
      beforeReturn: async (input) => {
        if (
          input.group.step === 2 &&
          input.messages.some(({ text }) => text === '先讨论旧主题。')
        ) {
          held = true;
          await barrier;
        }
      },
    });
    const { ids, path } = await group();
    const members = (await detail(path)).members;
    const ordered = ids
      .slice(0, 2)
      .map((id) => members.find((member) => member.companionId === id)!.id);
    const initial = await send(path, '先讨论旧主题。', { mode: 'each', membershipIds: ordered });
    await app.get(TaskWorkerService).start();
    try {
      await vi.waitFor(() => expect(held).toBe(true), { timeout: 18000, interval: 100 });
      await publish(path, '先纠正主题，保留已经说出的部分。');
      const state = groupTurnSchema.parse(
        (await owner.get(`${path}/turns/${initial.turn.id}`).expect(200)).body.data,
      );
      expect(state).toMatchObject({
        interruptedAt: expect.any(String),
        task: { status: 'cancelled', progress: { completedSteps: 1 } },
        steps: [
          { state: 'spoken', publishedMessageId: expect.any(String) },
          { state: 'pending', publishedMessageId: null },
        ],
      });
    } finally {
      release();
    }
    const next = await send(path, '现在请阿溪回答。', {
      mode: 'mention',
      membershipId: ordered[1]!,
    });
    expect((await success(path, next.turn.id)).steps).toMatchObject([
      { state: 'spoken', membershipId: ordered[1] },
    ]);
    const messages = (await owner.get(`${path}/messages`).expect(200)).body.data.items;
    expect(messages.map((row: { text: string }) => row.text)).toEqual([
      '先讨论旧主题。',
      '已发布的测试意见：阿澜，第1位。',
      '先纠正主题，保留已经说出的部分。',
      '现在请阿溪回答。',
      '已发布的测试意见：阿溪，第1位。',
    ]);
  }, 40000);
});
