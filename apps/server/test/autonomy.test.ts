import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  activitySchema,
  autonomyOpportunitiesSchema,
  contactIntentsSchema,
} from '@memory-weave/contracts';
import type { AutonomyOpportunity } from '@memory-weave/contracts';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app';
import type { ServerConfig } from '../src/config';
import { DatabaseService } from '../src/database/database.service';
import { autonomyUsage } from '../src/database/schema';
import { autonomyChoiceSchema } from '../src/modules/autonomy/autonomy-definition';
import { autonomyConfigurationSchema } from '../src/modules/autonomy/autonomy-config';
import { ModelRuntimeService } from '../src/modules/models/model-runtime.service';
import { TaskWorkerService } from '../src/modules/tasks/task-worker.service';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';
import { createTestAuthConfig, disposeTestAuth } from './support/redis';

afterAll(disposeTestAuth);

type Scope = { companionId: string; conversationId: string; runtimeEpoch: number; ownerId: string };

describe('F19 自主探索、工作与账户联系', () => {
  let app: INestApplication;
  let config: ServerConfig;
  let database: TestDatabase;
  let directory: string;
  let owner: ReturnType<typeof request.agent>;

  beforeEach(async () => {
    database = await createTestDatabase();
    directory = await mkdtemp(join(tmpdir(), 'memory-weave-autonomy-'));
    config = {
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      qdrantUrl: 'http://127.0.0.1:1',
      qdrantApiKey: 'isolated-vector-key',
      ...createTestAuthConfig(),
      adminPassword: 'autonomy-test-password',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir: directory,
      webDistDir: null,
      autonomyConfiguration: autonomyConfigurationSchema.parse({
        explorationsPerDay: 1,
        explorationIntervalMs: 60000,
        contactsPerDay: 1,
        quietStartHour: 0,
        quietEndHour: 0,
      }),
    };
  }, 30000);

  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
    await database?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30000);

  /** 用同一隔离主库与账号启动应用，测试可重启。 */
  async function boot() {
    app = await createApplication(config);
    owner = request.agent(app.getHttpServer());
    await owner.post('/api/auth/login').send({ password: config.adminPassword }).expect(200);
  }

  /** 创建最终授权所指向的真实私聊。 */
  async function setup(name: string): Promise<Scope> {
    const companion = (
      await owner
        .post('/api/companions')
        .send({
          requestId: randomUUID(),
          name,
          initialProfile: '喜欢有证据的短篇写作。',
        })
        .expect(201)
    ).body.data;
    const chat = (
      await owner
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          companionId: companion.id,
          runtimeEpoch: 1,
          title: name,
        })
        .expect(201)
    ).body.data;
    return {
      companionId: companion.id,
      conversationId: chat.id,
      ownerId: companion.ownerId,
      runtimeEpoch: 1,
    };
  }

  /** 提交一次显式授权版本。 */
  async function configure(
    scope: Scope,
    enabled: boolean,
    contactsEnabled: boolean,
    expectedVersion = 0,
  ) {
    return owner
      .put(`/api/companions/${scope.companionId}/autonomy`)
      .send({
        conversationId: scope.conversationId,
        runtimeEpoch: scope.runtimeEpoch,
        requestId: randomUUID(),
        expectedVersion,
        enabled,
        contactsEnabled,
      })
      .expect(200);
  }

  /** 确定性测试只替换候选，实际派发与预算行仍由服务端执行。 */
  function fixture(choices: Map<string, 'quiet' | 'contact' | 'write'>) {
    const runtime = app.get(ModelRuntimeService);
    const actual = runtime.execute.bind(runtime);
    vi.spyOn(runtime, 'execute').mockImplementation(
      (ownerId, command, definition, scope, guard) => {
        if (definition.outputSchema !== autonomyChoiceSchema)
          return actual(ownerId, command, definition, scope, guard);
        const choice = choices.get(scope!.companionId!) ?? 'quiet';
        return actual(
          ownerId,
          command,
          {
            ...definition,
            testOutput: () => ({
              choice,
              reason: '合成测试机会。',
              text:
                choice === 'contact'
                  ? '想和你聊聊最近的故事。'
                  : choice === 'write'
                    ? '写一段关于桥的短篇。'
                    : null,
            }),
          },
          scope,
          guard,
        );
      },
    );
  }

  /** 等待当前机会有确切结果。 */
  async function opportunity(scope: Scope, outcome: AutonomyOpportunity['outcome']) {
    return vi.waitFor(
      async () => {
        const response = await owner
          .get(`/api/companions/${scope.companionId}/autonomy/opportunities?runtimeEpoch=1`)
          .expect(200);
        const row = autonomyOpportunitiesSchema
          .parse(response.body.data)
          .items.find((item) => item.outcome === outcome);
        expect(row).toBeDefined();
        return row!;
      },
      { timeout: 19000, interval: 100 },
    );
  }

  /** 查询用户级联系视图。 */
  async function contacts() {
    return contactIntentsSchema.parse(
      (await owner.get('/api/autonomy/contacts').expect(200)).body.data,
    ).items;
  }

  it('没有授权时保持安静，许可机会可以安静或实际完成伴侣自己的写作', async () => {
    await boot();
    const quiet = await setup('安静伴侣');
    const writer = await setup('写作伴侣');
    fixture(new Map([[writer.companionId, 'write']]));
    await app.get(TaskWorkerService).start();
    expect(
      (await owner.get(`/api/companions/${quiet.companionId}/autonomy?runtimeEpoch=1`).expect(200))
        .body.data,
    ).toBeNull();
    expect(
      (
        await owner
          .get(`/api/companions/${quiet.companionId}/autonomy/opportunities?runtimeEpoch=1`)
          .expect(200)
      ).body.data.items,
    ).toEqual([]);
    await configure(quiet, true, false);
    await configure(writer, true, false);
    expect(await opportunity(quiet, 'quiet')).toMatchObject({ activityId: null, contactId: null });
    const result = await opportunity(writer, 'activity');
    const artifact = await vi.waitFor(
      async () => {
        const value = activitySchema.parse(
          (await owner.get(`/api/activities/${result.activityId}`).expect(200)).body.data,
        );
        expect(value.task.status).toBe('succeeded');
        return value;
      },
      { timeout: 16000, interval: 100 },
    );
    expect(artifact).toMatchObject({
      origin: 'companion',
      artifact: { kind: 'write', mode: 'test' },
      delivery: 'available',
    });
    const used = await app
      .get(DatabaseService)
      .sql.select()
      .from(autonomyUsage)
      .where(
        and(
          eq(autonomyUsage.ownerId, writer.ownerId),
          eq(autonomyUsage.companionId, writer.companionId),
          eq(autonomyUsage.kind, 'model'),
        ),
      );
    expect(used).toHaveLength(3);
    expect(await contacts()).toEqual([]);
  }, 40000);

  it('联系额度跨实例和重启生效，确认只适用于实际已发布的联系', async () => {
    await boot();
    const a = await setup('阿澜');
    const b = await setup('阿溪');
    fixture(
      new Map([
        [a.companionId, 'contact'],
        [b.companionId, 'contact'],
      ]),
    );
    await configure(a, true, true);
    await configure(b, true, true);
    await app.get(TaskWorkerService).start();
    const pendingAndSent = await vi.waitFor(
      async () => {
        const all = await contacts();
        expect(all).toHaveLength(2);
        expect(all.filter((item) => item.state === 'published')).toHaveLength(1);
        const waiting = all.find((item) => item.state === 'pending');
        expect(waiting?.reason).toBe('contact_daily_limit');
        return { sent: all.find((item) => item.state === 'published')!, waiting: waiting! };
      },
      { timeout: 21000, interval: 100 },
    );
    const { sent, waiting } = pendingAndSent;
    expect(sent.messageId).toEqual(expect.any(String));
    const message = (
      await owner
        .get(`/api/conversations/${sent.conversationId}/messages/${sent.messageId}`)
        .expect(200)
    ).body.data;
    expect(message).toMatchObject({ sourceKind: 'model_output', text: '想和你聊聊最近的故事。' });
    await owner.post(`/api/autonomy/contacts/${waiting.id}/acknowledge`).expect(409);
    const path = `/api/autonomy/contacts/${sent.id}/acknowledge`;
    const ack = (await owner.post(path).expect(200)).body.data;
    expect(ack.state).toBe('acknowledged');
    expect((await owner.post(path).expect(200)).body.data.acknowledgedAt).toBe(ack.acknowledgedAt);
    await app.close();
    await boot();
    await app.get(TaskWorkerService).start();
    const after = await contacts();
    expect(after.find((item) => item.id === sent.id)).toMatchObject({
      state: 'acknowledged',
      acknowledgedAt: ack.acknowledgedAt,
    });
    expect(after.find((item) => item.id === waiting.id)).toMatchObject({
      state: 'pending',
      messageId: null,
    });
    await configure(waiting.companionId === a.companionId ? a : b, false, false, 1);
    await vi.waitFor(
      async () => {
        expect((await contacts()).find((item) => item.id === waiting.id)).toMatchObject({
          state: 'cancelled',
          reason: 'contact_permission_changed',
          messageId: null,
        });
      },
      { timeout: 10000, interval: 100 },
    );
  }, 45000);

  it('自主生成额度用完时保留写作检查点，用户另外委托仍可完成', async () => {
    config.autonomyConfiguration!.modelCallsPerDay = 2;
    await boot();
    const a = await setup('限额伴侣');
    fixture(new Map([[a.companionId, 'write']]));
    await configure(a, true, false);
    await app.get(TaskWorkerService).start();
    const planned = await opportunity(a, 'activity');
    await vi.waitFor(
      async () => {
        const value = activitySchema.parse(
          (await owner.get(`/api/activities/${planned.activityId}`).expect(200)).body.data,
        );
        expect(value).toMatchObject({
          artifact: null,
          task: {
            status: 'waiting',
            reason: 'autonomy_generation_budget',
            progress: { completedSteps: 1 },
          },
        });
      },
      { timeout: 18000, interval: 100 },
    );
    const delegated = (
      await owner
        .post('/api/activities')
        .send({
          companionId: a.companionId,
          conversationId: a.conversationId,
          runtimeEpoch: a.runtimeEpoch,
          requestId: randomUUID(),
          specification: { kind: 'write', goal: '用户现在委托另一段文字。' },
        })
        .expect(201)
    ).body.data;
    await vi.waitFor(
      async () => {
        const value = activitySchema.parse(
          (await owner.get(`/api/activities/${delegated.id}`).expect(200)).body.data,
        );
        expect(value).toMatchObject({
          origin: 'user',
          task: { status: 'succeeded' },
          artifact: { kind: 'write' },
        });
      },
      { timeout: 18000, interval: 100 },
    );
  }, 45000);
});
