import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { loadServerConfig } from '../src/config';
import type { ServerConfig } from '../src/config';
import { TaskWorkerService } from '../src/modules/tasks/task-worker.service';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../src/app';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';
import { retrievalConfigurationSchema } from '@memory-weave/contracts';
import type { MemoryDocument, RecallQuery } from '@memory-weave/contracts';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

describe('检索与未整理补读的公开协议', () => {
  let app: INestApplication;
  let database: TestDatabase;
  let dataDir: string;
  let agent: ReturnType<typeof request.agent>;
  let provider: Server | undefined;
  let responseValue: unknown;
  let config: ServerConfig;
  let embeddingCalls = 0;
  let ownerId = '';
  let child: ChildProcess | undefined;
  let proxy: Server | undefined;
  beforeEach(async () => {
    database = await createTestDatabase();
    dataDir = await mkdtemp(join(tmpdir(), 'memory-weave-recall-'));
    config = {
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      qdrantUrl: process.env.TEST_QDRANT_URL!,
      qdrantApiKey: process.env.TEST_QDRANT_API_KEY!,
      adminPassword: 'retrieval-test-password',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir,
      webDistDir: null,
    };
    app = await createApplication(config);
    embeddingCalls = 0;
    ownerId = '';
    agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: 'retrieval-test-password' }).expect(200);
  });
  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    child = undefined;
    proxy?.closeAllConnections();
    if (proxy) await new Promise<void>((resolve) => proxy!.close(() => resolve()));
    proxy = undefined;
    provider?.closeAllConnections();
    await app?.close();
    if (provider) await new Promise<void>((resolve) => provider!.close(() => resolve()));
    provider = undefined;
    // 只移除本用例独占部署身份的空间，不触碰共享测试服务的其他数据。
    if (ownerId) {
      const headers = { 'api-key': process.env.TEST_QDRANT_API_KEY! };
      const response = await fetch(`${process.env.TEST_QDRANT_URL}/collections`, { headers });
      const body = (await response.json()) as { result: { collections: { name: string }[] } };
      for (const collection of body.result.collections)
        if (collection.name.startsWith(`mw_${ownerId.replaceAll('-', '')}_`))
          await fetch(`${process.env.TEST_QDRANT_URL}/collections/${collection.name}`, {
            method: 'DELETE',
            headers,
          });
    }
    await database?.dispose();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });
  async function useProvider() {
    provider = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url?.endsWith('/embeddings')) {
        embeddingCalls++;
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const input = JSON.parse(Buffer.concat(chunks).toString()) as {
          input: string;
          dimensions?: number;
        };
        const cat = /猫|毛孩子|豆包/.test(input.input);
        res.end(
          JSON.stringify({
            model: 'embedding-fixture',
            data: [
              {
                index: 0,
                embedding: Array.from({ length: input.dimensions ?? 4 }, (_, i) =>
                  i === (cat ? 0 : 1) ? 1 : 0,
                ),
              },
            ],
            usage: { prompt_tokens: 8, total_tokens: 8 },
          }),
        );
        return;
      }
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(parts).toString()) as {
        response_format?: unknown;
        messages: { content: string }[];
      };
      if (!body.response_format) {
        const input = JSON.parse(body.messages.at(-1)!.content) as {
          recall?: { pending: { text: string }[] };
        };
        const latest = input.recall?.pending.find((item) => item.text.includes('杭州'));
        res.end(
          JSON.stringify({
            model: 'chat-fixture',
            choices: [
              {
                message: {
                  content: latest ? '你刚说已经搬到杭州文三路 18 号。' : '还没有读到新地址。',
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 30, completion_tokens: 30 },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          model: 'recall-fixture',
          choices: [{ message: { content: JSON.stringify(responseValue) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 30, completion_tokens: 70 },
        }),
      );
    });
    await new Promise<void>((resolve) => provider!.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('fixture 未启动');
    await app.close();
    config = loadServerConfig({
      DATABASE_URL: database.databaseUrl,
      ADMIN_PASSWORD: 'retrieval-test-password',
      QDRANT_URL: process.env.TEST_QDRANT_URL,
      QDRANT_API_KEY: process.env.TEST_QDRANT_API_KEY,
      DATA_DIR: dataDir,
      MEMORY_CONFIG_JSON: JSON.stringify({ enabled: false, contextMessages: 0 }),
      MODEL_PROVIDERS_JSON: JSON.stringify([
        {
          id: 'fixture',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKeyEnv: null,
          capabilities: ['structured', 'embedding', 'text'],
        },
      ]),
    });
    app = await createApplication(config);
    agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: 'retrieval-test-password' }).expect(200);
    const current = (await agent.get('/api/models/config')).body.data;
    Object.assign(current.config.tasks.memory, {
      providerId: 'fixture',
      model: 'recall-fixture',
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
    });
    await agent
      .put('/api/models/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: current.version,
        config: current.config,
        evaluationNote: '隔离检索测试。',
      })
      .expect(200);
  }
  async function remember(
    companionId: string,
    conversationId: string,
    text: string,
    options: { targetId?: string; targetVersion?: number; document?: Partial<MemoryDocument> } = {},
  ) {
    const messageId = await publish(conversationId, text);
    responseValue = {
      actions: [
        {
          action: options.targetId ? 'revise' : 'add',
          targetId: options.targetId ?? null,
          targetVersion: options.targetVersion ?? null,
          revisionKind: options.targetId ? 'change' : null,
          reason: '用户明确陈述。',
          document: {
            kind: 'semantic',
            claim: 'fact',
            subject: { kind: 'user', name: null },
            text,
            reality: 'real',
            storyKey: null,
            epistemic: 'statement',
            eventTime: null,
            validFrom: null,
            validUntil: null,
            ...options.document,
          },
          evidence: [{ messageId, contentVersion: 1, quote: text }],
        },
      ],
    };
    const batch = (
      await agent
        .post(`/api/companions/${companionId}/memories/organize`)
        .send({ requestId: randomUUID(), runtimeEpoch: 1, conversationId })
        .expect(201)
    ).body.data;
    await app.get(TaskWorkerService).start();
    for (let i = 0; i < 100; i++) {
      const task = (await agent.get(`/api/tasks/${batch.taskId}`).expect(200)).body.data;
      if (task.status === 'succeeded') {
        await app.get(TaskWorkerService).stop();
        return (
          await agent
            .get(
              `/api/companions/${companionId}/memories?runtimeEpoch=1&conversationId=${conversationId}`,
            )
            .expect(200)
        ).body.data.items.find(
          (item: { document: MemoryDocument }) => item.document.text === text,
        ) as { id: string; version: number; versionId: string };
      }
      if (['failed', 'blocked', 'cancelled'].includes(task.status))
        throw new Error(`整理失败：${task.reason}`);
      await delay(50);
    }
    throw new Error('整理未完成');
  }
  it('词法检索只返回当前版本，深度回忆保留历史标识，索引未完成仍能查到新版本', async () => {
    await useProvider();
    const a = await companion('记地址的 A');
    const source = await conversation([a]);
    const target = await conversation([a]);
    const old = await remember(a, source, '我的收货地址是上海淮海路 8 号。');
    const current = await remember(a, source, '我的收货地址已经改为杭州文三路 18 号。', {
      targetId: old.id,
      targetVersion: old.version,
    });
    const query = {
      requestId: randomUUID(),
      runtimeEpoch: 1,
      conversationId: target,
      query: '收货地址',
    };
    const recalled = (await agent.post(`/api/companions/${a}/recall`).send(query).expect(201)).body
      .data;
    expect(recalled.memories.map((item: { versionId: string }) => item.versionId)).toEqual([
      current.versionId,
    ]);
    expect(recalled.memories[0].channels).toContain('lexical');
    expect(recalled.memories[0].document.text).toContain('杭州');
    const history = (
      await agent
        .post(`/api/companions/${a}/recall`)
        .send({ ...query, requestId: randomUUID(), mode: 'history', memoryId: old.id })
        .expect(201)
    ).body.data;
    expect(history.memories.map((item: { versionId: string }) => item.versionId)).toContain(
      old.versionId,
    );
    expect(
      history.memories.find((item: { versionId: string }) => item.versionId === old.versionId)
        .current,
    ).toBe(false);
  });
  it('没有相关内容时不把最近记忆充作命中，补读超过预算明确保留覆盖缺口', async () => {
    await useProvider();
    const a = await companion('相关性与覆盖');
    const source = await conversation([a]);
    const target = await conversation([a]);
    await remember(a, source, '猫咪豆包不能吃虾。');
    const recall = async () =>
      (
        await agent
          .post(`/api/companions/${a}/recall`)
          .send({
            requestId: randomUUID(),
            runtimeEpoch: 1,
            conversationId: target,
            query: '量子计算机退相干',
          })
          .expect(201)
      ).body.data;
    expect((await recall()).memories).toEqual([]);
    await app.close();
    app = await createApplication({
      ...config,
      retrievalConfiguration: retrievalConfigurationSchema.parse({
        vectorEnabled: false,
        pendingMessages: 1,
        pendingCharacters: 1000,
      }),
    });
    agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: 'retrieval-test-password' }).expect(200);
    await publish(source, '第一条新补充。');
    const newest = await publish(source, '第二条完整的新补充。');
    const result = await recall();
    expect(result.coverage.pendingComplete).toBe(false);
    expect(result.pending).toMatchObject([{ messageId: newest, text: '第二条完整的新补充。' }]);
  });
  it('真实 Qdrant 向量召回保留渠道，换维度后隔离空间并补建新索引', async () => {
    await useProvider();
    const a = await companion('猫咪记忆');
    const source = await conversation([a]);
    const target = await conversation([a]);
    const memory = await remember(a, source, '猫咪豆包不能吃虾。');
    const configure = async (dimensions: number) => {
      const current = (await agent.get('/api/models/config')).body.data;
      Object.assign(current.config.tasks.embedding, {
        providerId: 'fixture',
        model: 'embedding-fixture',
        dimensions,
        inputMicrosPerMillion: 0,
        outputMicrosPerMillion: 0,
      });
      await agent
        .put('/api/models/config')
        .send({
          requestId: randomUUID(),
          expectedVersion: current.version,
          config: current.config,
          evaluationNote: '隔离 embedding 协议测试。',
        })
        .expect(200);
    };
    await configure(4);
    await app.get(TaskWorkerService).start();
    let firstSpace = '';
    await expect
      .poll(
        async () => {
          const r = await agent.get(`/api/companions/${a}/recall/indexes?runtimeEpoch=1`);
          if (r.status !== 200) return null;
          firstSpace = r.body.data.space;
          const indexed = r.body.data.items.find(
            (item: { versionId: string; space: string }) =>
              item.versionId === memory.versionId && item.space === firstSpace,
          );
          if (indexed?.taskId) {
            const task = (await agent.get(`/api/tasks/${indexed.taskId}`)).body.data;
            if (['failed', 'blocked'].includes(task.status)) return `${task.status}:${task.reason}`;
          }
          return indexed?.status;
        },
        { timeout: 10000 },
      )
      .toBe('indexed');
    const body = {
      requestId: randomUUID(),
      runtimeEpoch: 1,
      conversationId: target,
      query: '毛孩子的忌口',
    };
    const recalled = (await agent.post(`/api/companions/${a}/recall`).send(body).expect(201)).body
      .data;
    expect(recalled.coverage.vector).toBe('ready');
    expect(
      recalled.memories.find((item: { id: string }) => item.id === memory.id).channels,
    ).toContain('vector');
    const unrelated = (
      await agent
        .post(`/api/companions/${a}/recall`)
        .send({
          ...body,
          requestId: randomUUID(),
          query: '量子计算机退相干',
        })
        .expect(201)
    ).body.data;
    expect(unrelated.memories).toEqual([]);
    const firstIndex = (
      await agent.get(`/api/companions/${a}/recall/indexes?runtimeEpoch=1`)
    ).body.data.items.find((item: { space: string }) => item.space === firstSpace);
    const removed = await fetch(
      `${process.env.TEST_QDRANT_URL}/collections/${firstIndex.collection}`,
      { method: 'DELETE', headers: { 'api-key': process.env.TEST_QDRANT_API_KEY! } },
    );
    expect(removed.ok).toBe(true);
    const beforeRebuild = embeddingCalls;
    const rebuilt = await agent
      .post(`/api/companions/${a}/recall/indexes/${firstIndex.id}/retry`)
      .send({ requestId: randomUUID(), runtimeEpoch: 1, conversationId: source })
      .expect(201);
    await expect
      .poll(
        async () => (await agent.get(`/api/tasks/${rebuilt.body.data.taskId}`)).body.data.status,
        { timeout: 8000 },
      )
      .toBe('succeeded');
    expect(embeddingCalls).toBe(beforeRebuild);
    await configure(6);
    await expect
      .poll(
        async () => {
          const r = (
            await agent.get(`/api/companions/${a}/recall/indexes?runtimeEpoch=1`).expect(200)
          ).body.data;
          if (r.space === firstSpace) return null;
          return r.items.find((item: { space: string }) => item.space === r.space)?.status;
        },
        { timeout: 10000 },
      )
      .toBe('indexed');
    const next = (
      await agent
        .post(`/api/companions/${a}/recall`)
        .send({ ...body, requestId: randomUUID() })
        .expect(201)
    ).body.data;
    expect(next.memories.find((item: { id: string }) => item.id === memory.id).channels).toContain(
      'vector',
    );
  }, 30000);
  it('真实聊天模型收到跨私聊新补充和旧记忆，不等整理即可使用新地址', async () => {
    await useProvider();
    const a = await companion('住址伴侣');
    const source = await conversation([a]);
    await remember(a, source, '我的收货地址是上海淮海路 8 号。');
    const latest = await publish(source, '我刚搬到杭州文三路 18 号。');
    const current = (await agent.get('/api/models/config')).body.data;
    Object.assign(current.config.tasks.chat, {
      providerId: 'fixture',
      model: 'chat-fixture',
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
    });
    await agent
      .put('/api/models/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: current.version,
        config: current.config,
        evaluationNote: '隔离聊天上下文验收。',
      })
      .expect(200);
    const chat = (
      await agent
        .post('/api/chats')
        .send({ requestId: randomUUID(), companionId: a, runtimeEpoch: 1, title: '另一场私聊' })
        .expect(201)
    ).body.data;
    const sent = (
      await agent
        .post(`/api/chats/${chat.id}/messages`)
        .send({ requestId: randomUUID(), text: '我现在的收货地址是什么？' })
        .expect(201)
    ).body.data;
    await app.get(TaskWorkerService).start();
    await expect
      .poll(async () => (await agent.get(`/api/tasks/${sent.run.id}`)).body.data.status, {
        timeout: 8000,
      })
      .toBe('succeeded');
    const view = (await agent.get(`/api/chats/${chat.id}`).expect(200)).body.data;
    expect(
      view.currentRun.context.recall.pending.map((item: { messageId: string }) => item.messageId),
    ).toContain(latest);
    expect(view.currentRun.context.recall.memories[0].document.text).toContain('上海');
    const history = (await agent.get(`/api/chats/${chat.id}/messages`).expect(200)).body.data;
    expect(
      history.items.map((item: { message: { text: string } }) => item.message.text).join(''),
    ).toContain('你刚说已经搬到杭州');
  }, 15000);
  it.each([false, true])(
    '删除记忆来源立即限制跨私聊，清除派生回复和向量，独立原文保留（先重置：%s）',
    async (resetFirst) => {
      await useProvider();
      const a = await companion('删除传播');
      const source = await conversation([a]);
      const memory = await remember(a, source, '我的收货地址是上海淮海路 8 号。');
      const originals = (await agent.get(`/api/conversations/${source}/messages`).expect(200)).body
        .data.items;
      const sourceId = originals[0].id as string;
      const current = (await agent.get('/api/models/config')).body.data;
      Object.assign(current.config.tasks.embedding, {
        providerId: 'fixture',
        model: 'embedding-fixture',
        inputMicrosPerMillion: 0,
        outputMicrosPerMillion: 0,
      });
      await agent
        .put('/api/models/config')
        .send({
          requestId: randomUUID(),
          expectedVersion: current.version,
          config: current.config,
          evaluationNote: '删除索引验收。',
        })
        .expect(200);
      const chat = (
        await agent
          .post('/api/chats')
          .send({ requestId: randomUUID(), companionId: a, runtimeEpoch: 1, title: '派生回复' })
          .expect(201)
      ).body.data;
      const sent = (
        await agent
          .post(`/api/chats/${chat.id}/messages`)
          .send({ requestId: randomUUID(), text: '收货地址是什么？' })
          .expect(201)
      ).body.data;
      await app.get(TaskWorkerService).start();
      await expect
        .poll(async () => (await agent.get(`/api/tasks/${sent.run.id}`)).body.data.status, {
          timeout: 8000,
        })
        .toBe('succeeded');
      await expect
        .poll(
          async () =>
            (
              await agent.get(`/api/companions/${a}/recall/indexes?runtimeEpoch=1`)
            ).body.data.items.find(
              (item: { versionId: string }) => item.versionId === memory.versionId,
            )?.status,
          { timeout: 8000 },
        )
        .toBe('indexed');
      await app.get(TaskWorkerService).stop();
      if (resetFirst) {
        const c = (await agent.get(`/api/companions/${a}`)).body.data;
        const reset = (
          await agent
            .post('/api/lifecycle')
            .send({
              requestId: randomUUID(),
              kind: 'reset_companion',
              companionId: a,
              runtimeEpoch: 1,
              expectedVersion: c.version,
            })
            .expect(201)
        ).body.data;
        await app.get(TaskWorkerService).start();
        await expect
          .poll(async () => (await agent.get(`/api/lifecycle/${reset.id}`)).body.data.status, {
            timeout: 10000,
          })
          .toBe('completed');
        await app.get(TaskWorkerService).stop();
      }
      const detail = (await agent.get(`/api/conversations/${source}`)).body.data;
      const operation = (
        await agent
          .post('/api/lifecycle')
          .send({
            requestId: randomUUID(),
            kind: 'delete_messages',
            conversationId: source,
            expectedVersion: detail.conversation.version,
            messages: [{ messageId: sourceId, contentVersion: 1 }],
          })
          .expect(201)
      ).body.data;
      expect((await agent.get(`/api/chats/${chat.id}`).expect(200)).body.data.availability).toBe(
        'cleaning',
      );
      await agent.get(`/api/chats/${chat.id}/messages`).expect(409);
      await app.get(TaskWorkerService).start();
      await expect
        .poll(async () => (await agent.get(`/api/lifecycle/${operation.id}`)).body.data.status, {
          timeout: 10000,
        })
        .toBe('completed');
      const history = (await agent.get(`/api/chats/${chat.id}/messages`).expect(200)).body.data
        .items;
      expect(
        history.find((item: { message: { id: string } }) => item.message.id === sent.message.id)
          .message.text,
      ).toBe('收货地址是什么？');
      expect(
        history
          .filter((item: { runId: string | null }) => item.runId === sent.run.id)
          .every(
            (item: { message: { deletedAt: string | null } }) => item.message.deletedAt !== null,
          ),
      ).toBe(true);
      if (resetFirst) return;
      const indexes = (await agent.get(`/api/companions/${a}/recall/indexes?runtimeEpoch=1`)).body
        .data;
      expect(
        indexes.items.find((item: { versionId: string }) => item.versionId === memory.versionId)
          .status,
      ).toBe('deleted');
    },
    30000,
  );
  it('Qdrant 故障不丢记忆，恢复后显式重试复用成功 embedding，不重复计费', async () => {
    await useProvider();
    const a = await companion('索引恢复');
    const source = await conversation([a]);
    const memory = await remember(a, source, '猫咪豆包不能吃虾。');
    const current = (await agent.get('/api/models/config')).body.data;
    Object.assign(current.config.tasks.embedding, {
      providerId: 'fixture',
      model: 'embedding-fixture',
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
    });
    await agent
      .put('/api/models/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: current.version,
        config: current.config,
        evaluationNote: '索引恢复验收。',
      })
      .expect(200);
    const restart = async (qdrantUrl: string) => {
      await app.close();
      app = await createApplication({ ...config, qdrantUrl });
      agent = request.agent(app.getHttpServer());
      await agent.post('/api/auth/login').send({ password: 'retrieval-test-password' }).expect(200);
    };
    await restart('http://127.0.0.1:1');
    await app.get(TaskWorkerService).start();
    let indexId = '',
      oldTask = '';
    await expect
      .poll(
        async () => {
          const index = (
            await agent.get(`/api/companions/${a}/recall/indexes?runtimeEpoch=1`)
          ).body.data.items.find(
            (item: { versionId: string }) => item.versionId === memory.versionId,
          );
          if (!index) return null;
          indexId = index.id;
          oldTask = index.taskId;
          return (await agent.get(`/api/tasks/${oldTask}`)).body.data.status;
        },
        { timeout: 12000 },
      )
      .toBe('failed');
    expect(embeddingCalls).toBe(1);
    await restart(process.env.TEST_QDRANT_URL!);
    const command = { requestId: randomUUID(), runtimeEpoch: 1, conversationId: source };
    const retried = await agent
      .post(`/api/companions/${a}/recall/indexes/${indexId}/retry`)
      .send(command)
      .expect(201);
    expect(retried.body.data.taskId).not.toBe(oldTask);
    expect(
      (
        await agent
          .post(`/api/companions/${a}/recall/indexes/${indexId}/retry`)
          .send(command)
          .expect(201)
      ).body.data.taskId,
    ).toBe(retried.body.data.taskId);
    await app.get(TaskWorkerService).start();
    await expect
      .poll(
        async () => (await agent.get(`/api/tasks/${retried.body.data.taskId}`)).body.data.status,
        { timeout: 8000 },
      )
      .toBe('succeeded');
    expect(embeddingCalls).toBe(1);
    expect((await agent.get(`/api/tasks/${oldTask}`)).body.data.status).toBe('failed');
  }, 30000);
  it('向量已落库但检查点前强杀进程，租约恢复复用成功编码且不复制点', async () => {
    await useProvider();
    const a = await companion('强杀恢复');
    const source = await conversation([a]);
    const memory = await remember(a, source, '猫咪豆包不能吃虾。');
    const current = (await agent.get('/api/models/config')).body.data;
    Object.assign(current.config.tasks.embedding, {
      providerId: 'fixture',
      model: 'embedding-fixture',
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
    });
    await agent
      .put('/api/models/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: current.version,
        config: current.config,
        evaluationNote: '隔离进程恢复。',
      })
      .expect(200);
    const scheduler = (await agent.get('/api/tasks/config')).body.data;
    await agent
      .put('/api/tasks/config')
      .send({
        requestId: randomUUID(),
        expectedVersion: scheduler.version,
        config: { ...scheduler.config, pollMs: 100, leaseMs: 1000, retryBaseMs: 100 },
      })
      .expect(200);
    let written = false;
    proxy = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const remote = await fetch(`${process.env.TEST_QDRANT_URL}${req.url}`, {
          method: req.method,
          headers: {
            'api-key': process.env.TEST_QDRANT_API_KEY!,
            'Content-Type': 'application/json',
          },
          body: chunks.length ? Buffer.concat(chunks) : undefined,
          signal: AbortSignal.timeout(5000),
        });
        const body = await remote.text();
        if (req.method === 'PUT' && req.url?.includes('/points?') && remote.ok) {
          written = true;
          return;
        }
        res.writeHead(remote.status, { 'Content-Type': 'application/json' });
        res.end(body);
      } catch {
        res.writeHead(503);
        res.end();
      }
    });
    await new Promise<void>((resolve) => proxy!.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('代理未启动');
    child = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./support/task-process.ts', import.meta.url))],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DATABASE_URL: database.databaseUrl,
          ADMIN_PASSWORD: config.adminPassword,
          DATA_DIR: dataDir,
          QDRANT_URL: `http://127.0.0.1:${address.port}`,
          QDRANT_API_KEY: config.qdrantApiKey,
          MODEL_PROVIDERS_JSON: JSON.stringify(
            config.modelDeployment!.providers.map((p) => ({
              id: p.id,
              baseUrl: p.baseUrl,
              apiKeyEnv: null,
              capabilities: p.capabilities,
            })),
          ),
          MEMORY_CONFIG_JSON: JSON.stringify({ enabled: false }),
          RETRIEVAL_CONFIG_JSON: JSON.stringify({ vectorTimeoutMs: 10000 }),
        },
      },
    );
    await expect.poll(() => written, { timeout: 10000 }).toBe(true);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const index = (
      await agent.get(`/api/companions/${a}/recall/indexes?runtimeEpoch=1`).expect(200)
    ).body.data.items.find((i: { versionId: string }) => i.versionId === memory.versionId);
    expect(
      (await agent.get(`/api/tasks/${index.taskId}`).expect(200)).body.data.progress.completedSteps,
    ).toBe(1);
    await app.get(TaskWorkerService).start();
    await expect
      .poll(async () => (await agent.get(`/api/tasks/${index.taskId}`)).body.data.status, {
        timeout: 10000,
      })
      .toBe('succeeded');
    expect(embeddingCalls).toBe(1);
    const points = await fetch(
      `${process.env.TEST_QDRANT_URL}/collections/${index.collection}/points/count`,
      {
        method: 'POST',
        headers: {
          'api-key': process.env.TEST_QDRANT_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ exact: true }),
      },
    );
    expect(((await points.json()) as { result: { count: number } }).result.count).toBe(1);
  }, 30000);
  it('固定中文语料按人工标注召回，姓名别名、普通陈述、对象与故事范围不混淆', async () => {
    const corpus = JSON.parse(
      await readFile(
        new URL('../../../evaluations/retrieval/f09-corpus.json', import.meta.url),
        'utf8',
      ),
    ) as {
      entries: { key: string; text: string; document: Partial<MemoryDocument> }[];
      queries: (Partial<RecallQuery> & { name: string; query: string; expected: string[] })[];
    };
    await useProvider();
    const a = await companion('中文基线');
    const source = await conversation([a]),
      target = await conversation([a]);
    const ids = new Map<string, string>();
    for (const entry of corpus.entries) {
      const memory = await remember(a, source, entry.text, { document: entry.document });
      ids.set(entry.key, memory.id);
    }
    for (const { name, expected, ...query } of corpus.queries) {
      const result = (
        await agent
          .post(`/api/companions/${a}/recall`)
          .send({ requestId: randomUUID(), runtimeEpoch: 1, conversationId: target, ...query })
          .expect(201)
      ).body.data;
      expect(result.memories.map((m: { id: string }) => m.id).sort(), name).toEqual(
        expected.map((key) => ids.get(key)!).sort(),
      );
    }
  }, 20000);
  async function companion(name: string) {
    const response = await agent
      .post('/api/companions')
      .send({ requestId: randomUUID(), name, initialProfile: '用于检索验收的初始人生。' })
      .expect(201);
    ownerId = response.body.data.ownerId as string;
    return response.body.data.id as string;
  }
  async function conversation(companionIds: string[]) {
    const response = await agent
      .post('/api/conversations')
      .send({
        requestId: randomUUID(),
        title: '检索范围',
        kind: companionIds.length === 1 ? 'private' : 'group',
        includeUser: true,
        companions: companionIds.map((companionId) => ({ companionId, runtimeEpoch: 1 })),
      })
      .expect(201);
    return response.body.data.conversation.id as string;
  }
  async function publish(conversationId: string, text: string) {
    const response = await agent.get(`/api/conversations/${conversationId}`).expect(200);
    const expectedConversationVersion = response.body.data.conversation.version as number;
    const saved = await agent
      .post(`/api/conversations/${conversationId}/messages`)
      .send({
        requestId: randomUUID(),
        speaker: { kind: 'user' },
        text,
        expectedConversationVersion,
      })
      .expect(201);
    const published = await agent
      .post(`/api/conversations/${conversationId}/messages/${saved.body.data.id}/publish`)
      .send({
        requestId: randomUUID(),
        expectedRevision: saved.body.data.revision,
        expectedConversationVersion,
      })
      .expect(201);
    return published.body.data.id as string;
  }
  it('跨私聊读取本实例未整理的新地址，普通陈述也检索，其他实例和群聊不能取得私聊', async () => {
    const a = await companion('A');
    const b = await companion('B');
    const source = await conversation([a]);
    const destination = await conversation([a]);
    const bChat = await conversation([b]);
    const group = await conversation([a, b]);
    const latest = await publish(source, '我已经搬到杭州文三路 18 号了。');
    await publish(bChat, '我住成都，这是 B 的私聊。');
    const body = {
      requestId: randomUUID(),
      runtimeEpoch: 1,
      conversationId: destination,
      query: '给我寄东西用新地址就好。',
    };
    const recalled = await agent.post(`/api/companions/${a}/recall`).send(body).expect(201);
    expect(recalled.body.data.pending.map((item: { messageId: string }) => item.messageId)).toEqual(
      [latest],
    );
    expect(recalled.body.data.pending[0].text).toBe('我已经搬到杭州文三路 18 号了。');
    expect(recalled.body.data.coverage.pendingComplete).toBe(true);
    const other = await agent
      .post(`/api/companions/${b}/recall`)
      .send({ ...body, requestId: randomUUID(), conversationId: bChat })
      .expect(201);
    expect(JSON.stringify(other.body.data)).not.toContain('文三路');
    const grouped = await agent
      .post(`/api/companions/${a}/recall`)
      .send({ ...body, requestId: randomUUID(), conversationId: group })
      .expect(201);
    expect(grouped.body.data.pending).toEqual([]);
  });
});
