import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from 'mysql2/promise';
import request from 'supertest';
import { createApplication } from '../../src/app';
import { loadServerConfig } from '../../src/config';
import { TaskWorkerService } from '../../src/modules/tasks/task-worker.service';
import { createTestDatabase } from './database';
import { mysqlConnectionOptions } from '../../src/database/connection';
import type { MemoryExplorerPage } from '@memory-weave/contracts';

// 所有业务记录经 HTTP/固定模型 fixture 创建；SQL 仅用于查询计划和隔离索引实验。
const database = await createTestDatabase();
const directory = await mkdtemp(join(tmpdir(), 'mw-explorer-benchmark-'));
let value: unknown = { actions: [] };
const provider = createServer((_req, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 30, completion_tokens: 120 },
    }),
  );
});
await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
const address = provider.address();
if (!address || typeof address === 'string') throw new Error('fixture unavailable');
const app = await createApplication(
  loadServerConfig({
    DATABASE_URL: database.databaseUrl,
    ADMIN_PASSWORD: 'isolated-benchmark-only-password',
    DATA_DIR: directory,
    QDRANT_API_KEY: 'isolated-test-vector-key',
    MEMORY_CONFIG_JSON: JSON.stringify({ enabled: false, contextMessages: 0, relatedMemories: 0 }),
    MODEL_PROVIDERS_JSON: JSON.stringify([
      {
        id: 'fixture',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKeyEnv: null,
        capabilities: ['structured'],
      },
    ]),
  }),
);
const agent = request.agent(app.getHttpServer());
const connection = await createConnection(mysqlConnectionOptions(database.databaseUrl));
try {
  await agent
    .post('/api/auth/login')
    .send({ password: 'isolated-benchmark-only-password' })
    .expect(200);
  const models = (await agent.get('/api/models/config')).body.data;
  Object.assign(models.config.dailyBudget, { requests: 1000, tokens: 10000000 });
  Object.assign(models.config.tasks.memory, {
    providerId: 'fixture',
    model: 'fixture',
    maxInputTokens: 32768,
    maxOutputTokens: 16384,
    inputMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
  });
  Object.assign(models.config.tasks.memory.dailyBudget, { requests: 1000, tokens: 10000000 });
  await agent
    .put('/api/models/config')
    .send({
      requestId: randomUUID(),
      expectedVersion: models.version,
      config: models.config,
      evaluationNote: '隔离基准，仅访问本地 fixture，零模型费用。',
    })
    .expect(200);
  const taskConfig = (await agent.get('/api/tasks/config')).body.data;
  taskConfig.config.pollMs = 100;
  await agent
    .put('/api/tasks/config')
    .send({
      requestId: randomUUID(),
      expectedVersion: taskConfig.version,
      config: taskConfig.config,
    })
    .expect(200);
  const companion = (
    await agent
      .post('/api/companions')
      .send({ requestId: randomUUID(), name: '隔离基准', initialProfile: '性能验收实例。' })
      .expect(201)
  ).body.data;
  const conversation = (
    await agent
      .post('/api/conversations')
      .send({
        requestId: randomUUID(),
        title: '性能语料',
        kind: 'private',
        includeUser: true,
        companions: [{ companionId: companion.id, runtimeEpoch: 1 }],
      })
      .expect(201)
  ).body.data.conversation;
  const ownerId = (await agent.get('/api/workspace')).body.data.ownerId;
  await app.get(TaskWorkerService).start();
  /** 固定候选只验证保存与读取，不将合成语料描述成模型效果。 */
  async function batch(texts: string[]): Promise<void> {
    const text = '隔离基准的固定原文。';
    let state = (await agent.get(`/api/conversations/${conversation.id}`)).body.data.conversation;
    const saved = (
      await agent
        .post(`/api/conversations/${conversation.id}/messages`)
        .send({
          requestId: randomUUID(),
          speaker: { kind: 'user' },
          expectedConversationVersion: state.version,
          text,
        })
        .expect(201)
    ).body.data;
    state = (await agent.get(`/api/conversations/${conversation.id}`)).body.data.conversation;
    await agent
      .post(`/api/conversations/${conversation.id}/messages/${saved.id}/publish`)
      .send({
        requestId: randomUUID(),
        expectedRevision: saved.revision,
        expectedConversationVersion: state.version,
      })
      .expect(201);
    value = {
      actions: texts.map((textValue) => ({
        action: 'add',
        targetId: null,
        targetVersion: null,
        revisionKind: null,
        document: {
          kind: 'semantic',
          claim: 'preference',
          subject: { kind: 'user', name: null },
          text: textValue,
          reality: 'real',
          storyKey: null,
          epistemic: 'statement',
          eventTime: null,
          validFrom: null,
          validUntil: null,
        },
        reason: '固定基准数据。',
        evidence: [{ messageId: saved.id, contentVersion: 1, quote: text }],
      })),
    };
    const queued = (
      await agent
        .post(`/api/companions/${companion.id}/memories/organize`)
        .send({ requestId: randomUUID(), runtimeEpoch: 1, conversationId: conversation.id })
        .expect(201)
    ).body.data;
    const deadline = Date.now() + 20000;
    while (true) {
      const status = (await agent.get(`/api/tasks/${queued.taskId}`).expect(200)).body.data.status;
      if (status === 'succeeded') return;
      if (['failed', 'blocked', 'cancelled'].includes(status) || Date.now() > deadline)
        throw new Error(`benchmark task ${status}`);
      await delay(50);
    }
  }
  for (let start = 0; start < 1000; start += 12) {
    await batch(
      Array.from(
        { length: Math.min(12, 1000 - start) },
        (_, offset) => `基准认识 ${String(start + offset).padStart(4, '0')}`,
      ),
    );
    if (start % 120 === 0)
      console.log(JSON.stringify({ event: 'seed', memories: Math.min(start + 12, 1000) }));
  }
  for (let index = 0; index < 50; index++) await batch(['基准认识 0000']);
  await app.get(TaskWorkerService).stop();
  const base = `/api/companions/${companion.id}/memory-explorer`;
  const focused = (
    await agent.get(`${base}/entries`).query({ runtimeEpoch: 1, q: '基准认识 0000' }).expect(200)
  ).body.data.items[0];
  const page: MemoryExplorerPage = (
    await agent.get(`${base}/entries`).query({ runtimeEpoch: 1, limit: 50 }).expect(200)
  ).body.data;
  const references = page.items.map((item) => ({
    versionId: item.versionId,
    stamp: item.readStamp,
  }));
  /** 限定一个进程顺序读取，另报告 4 并发端到端查询，不声称目标机器容量。 */
  async function measure() {
    const samples: Record<string, number[]> = {};
    const operations = {
      entries20: () => agent.get(`${base}/entries`).query({ runtimeEpoch: 1 }).expect(200),
      timeline20: () => agent.get(`${base}/timeline`).query({ runtimeEpoch: 1 }).expect(200),
      keyword20: () =>
        agent.get(`${base}/entries`).query({ runtimeEpoch: 1, q: '认识 09' }).expect(200),
      graph48: () =>
        agent
          .get(`${base}/graph`)
          .query({ runtimeEpoch: 1, centerKind: 'version', centerId: focused.versionId, limit: 48 })
          .expect(200),
      validate50: () =>
        agent.post(`${base}/validate`).send({ runtimeEpoch: 1, references }).expect(200),
    };
    for (const [name, operation] of Object.entries(operations)) {
      await operation();
      samples[name] = [];
      for (let index = 0; index < 30; index++) {
        const start = performance.now();
        await operation();
        samples[name]!.push(performance.now() - start);
      }
    }
    samples.concurrentEntries4 = [];
    for (let round = 0; round < 8; round++)
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          const start = performance.now();
          await operations.entries20();
          samples.concurrentEntries4!.push(performance.now() - start);
        }),
      );
    return Object.fromEntries(
      Object.entries(samples).map(([name, values]) => {
        const sorted = values.sort((a, b) => a - b);
        return [
          name,
          {
            samples: values.length,
            p50Ms: Number(sorted[Math.floor(values.length * 0.5)]!.toFixed(2)),
            p95Ms: Number(sorted[Math.ceil(values.length * 0.95) - 1]!.toFixed(2)),
          },
        ];
      }),
    );
  }
  async function explain() {
    const [time] = await connection.query(
      'EXPLAIN SELECT id FROM memory_versions WHERE owner_id = ? AND created_at <= NOW(3) ORDER BY created_at DESC, id DESC LIMIT 21',
      [ownerId],
    );
    const [previous] = await connection.query(
      'EXPLAIN SELECT id FROM memory_versions WHERE owner_id = ? AND previous_version_id = ? ORDER BY id LIMIT 21',
      [ownerId, focused.versionId],
    );
    return { time, previous };
  }
  // 基准拥有独占随机库；移除新索引获得同数据对照，随后恢复。不触碰部署库。
  await connection.query('DROP INDEX memory_version_time ON memory_versions');
  await connection.query('DROP INDEX memory_version_previous ON memory_versions');
  const before = { queries: await measure(), plans: await explain() };
  // 这两条 DDL 仅用于当前临时库的索引对照；正式发布仍走版本化迁移。
  await connection.query(
    'CREATE INDEX memory_version_time ON memory_versions (owner_id, created_at, id)',
  );
  await connection.query(
    'CREATE INDEX memory_version_previous ON memory_versions (owner_id, previous_version_id, id)',
  );
  const after = { queries: await measure(), plans: await explain() };
  const result = {
    measuredAt: new Date().toISOString(),
    dataset: {
      memories: 1000,
      versions: 1000,
      originalMessages: 134,
      extraEvidenceForOneMemory: 50,
    },
    environment: {
      node: process.version,
      cpus: cpus().length,
      cpu: cpus()[0]?.model,
      peakProcessRssKiB: process.resourceUsage().maxRSS,
    },
    before,
    after,
  };
  await writeFile(
    process.argv[2] ?? '/tmp/mw-f10-benchmark.json',
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify({ event: 'benchmark.complete', queries: after.queries }));
} finally {
  await connection.end();
  await app.close();
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await database.dispose();
  await rm(directory, { recursive: true, force: true });
}
