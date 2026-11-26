import { randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { personaTemplateBundleSchema } from '@memory-weave/contracts';
import request from 'supertest';
import { afterAll, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app';
import type { ServerConfig } from '../src/config';
import {
  assertRestoreReady,
  exportArchive,
  importArchive,
  inspectArchive,
} from '../src/database/archive-data';
import { acquireArchiveLock } from '../src/database/archive-lock';
import { replayArchive } from '../src/database/archive-replay';
import { readLifecycleJournal } from '../src/modules/lifecycle/lifecycle-journal';
import { TaskWorkerService } from '../src/modules/tasks/task-worker.service';
import { createTestDatabase } from './support/database';
import { createTestAuthConfig, disposeTestAuth } from './support/redis';

afterAll(disposeTestAuth);

it('F23 用旧备份恢复附件、人格版本及待办，同时应用新删除和实例重置', async () => {
  const source = await createTestDatabase();
  const target = await createTestDatabase();
  const root = await mkdtemp(join(tmpdir(), 'memory-weave-archive-'));
  const adminPassword = 'isolated-archive-password';
  const journal = join(root, 'journal');
  const archive = join(root, 'bundle');
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    ...createTestAuthConfig(),
    adminPassword,
    appOrigin: 'http://localhost:5173',
    cookieSecure: false,
    webDistDir: null,
    databaseUrl: source.databaseUrl,
    dataDir: join(root, 'source'),
    lifecycleJournalDir: journal,
    qdrantUrl: process.env.TEST_QDRANT_URL!,
    qdrantApiKey: process.env.TEST_QDRANT_API_KEY!,
  };
  const restore = {
    ...config,
    ...createTestAuthConfig(),
    databaseUrl: target.databaseUrl,
    dataDir: join(root, 'target'),
  };
  let app: INestApplication | undefined;
  /** 从独立数据库和文件目录启动验收应用。 */
  async function boot(settings: ServerConfig) {
    app = await createApplication(settings);
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ password: adminPassword }).expect(200);
    return agent;
  }
  /** 等待数据库落下实际清理结果。 */
  async function completed(agent: ReturnType<typeof request.agent>, operationId: string) {
    await vi.waitFor(
      async () => {
        expect(
          (await agent.get(`/api/lifecycle/${operationId}`).expect(200)).body.data.status,
        ).toBe('completed');
      },
      { timeout: 17000, interval: 100 },
    );
  }
  try {
    let agent = await boot(config);
    const template = (
      await agent
        .post('/api/persona-templates')
        .send({
          requestId: randomUUID(),
          name: '可复用初稿',
          initialProfile: '用户提供的虚构人物原稿。',
          lockedFeatures: ['保留独立思考'],
        })
        .expect(201)
    ).body.data;
    const bundle = personaTemplateBundleSchema.parse(
      (await agent.get(`/api/persona-templates/${template.id}/export`).expect(200)).body.data,
    );
    expect(Object.keys(bundle.template).sort()).toEqual([
      'initialProfile',
      'lockedFeatures',
      'name',
    ]);
    await agent
      .post('/api/persona-templates/import')
      .send({ requestId: randomUUID(), bundle: { ...bundle, sha256: '0'.repeat(64) } })
      .expect(400);
    const imported = (
      await agent
        .post('/api/persona-templates/import')
        .send({ requestId: randomUUID(), bundle })
        .expect(201)
    ).body.data;
    expect(imported.id).not.toBe(template.id);
    const a = (
      await agent
        .post('/api/companions')
        .send({ requestId: randomUUID(), name: '需要重置的 A', initialProfile: '保留初稿 A。' })
        .expect(201)
    ).body.data;
    const created = (
      await agent
        .post('/api/companion-creations')
        .send({
          requestId: randomUUID(),
          name: '保留版本的 B',
          source: { kind: 'text', profileText: '保留初稿 B。' },
        })
        .expect(201)
    ).body.data;
    await app!.get(TaskWorkerService).start();
    const b = await vi.waitFor(
      async () => {
        const row = (await agent.get(`/api/companions/${created.companion.id}`).expect(200)).body
          .data;
        expect(row.currentPersonaVersion.origin).toBe('initialization');
        return row;
      },
      { timeout: 15000, interval: 100 },
    );
    await app!.get(TaskWorkerService).stop();
    const initial = b.currentPersonaVersion;
    const revised = (
      await agent
        .post(`/api/companions/${b.id}/persona/locks`)
        .send({
          requestId: randomUUID(),
          runtimeEpoch: 1,
          expectedPersonaVersion: initial.version,
          lockedFeatures: ['保留准确出处'],
        })
        .expect(201)
    ).body.data;
    const room = (
      await agent
        .post('/api/conversations')
        .send({
          requestId: randomUUID(),
          title: '共同原文',
          kind: 'group',
          includeUser: true,
          companions: [a, b].map((person) => ({ companionId: person.id, runtimeEpoch: 1 })),
        })
        .expect(201)
    ).body.data.conversation;
    /** 保存实际原文，供生命周期选择删除。 */
    async function publish(text: string) {
      const expectedConversationVersion = (
        await agent.get(`/api/conversations/${room.id}`).expect(200)
      ).body.data.conversation.version;
      const draft = (
        await agent
          .post(`/api/conversations/${room.id}/messages`)
          .send({
            requestId: randomUUID(),
            expectedConversationVersion,
            speaker: { kind: 'user' },
            text,
          })
          .expect(201)
      ).body.data;
      return (
        await agent
          .post(`/api/conversations/${room.id}/messages/${draft.id}/publish`)
          .send({
            requestId: randomUUID(),
            expectedConversationVersion,
            expectedRevision: draft.revision,
          })
          .expect(201)
      ).body.data;
    }
    const removed = await publish('备份后明确删除的原文。');
    const retained = await publish('另一段仍可合法读取的共同原文。');
    const original = Buffer.from('持久附件，保留实际完整文件。');
    const material = (
      await agent
        .put('/api/materials')
        .query({ requestId: randomUUID(), filename: '附件.txt', kind: 'text' })
        .set('Content-Type', 'application/octet-stream')
        .send(original)
        .expect(200)
    ).body.data;
    const terminal = `/api/terminals/${randomUUID()}`;
    const credential = `/api/terminals/${randomUUID()}`;
    for (const path of [terminal, credential])
      await agent
        .put(path)
        .send({ name: '备份验收终端', secret: randomBytes(32).toString('hex') })
        .expect(200);
    const grant = {
      conversationId: room.id,
      companionId: b.id,
      runtimeEpoch: 1,
      workspaceId: 'isolated',
      tool: 'diagnostic.echo',
    };
    await agent
      .put(`${terminal}/grants`)
      .send({ ...grant, expectedVersion: 0, enabled: true })
      .expect(200);
    const task = (
      await agent
        .post('/api/tasks/diagnostics')
        .send({ requestId: randomUUID(), steps: 2 })
        .expect(201)
    ).body.data;
    await app!.close();
    app = undefined;
    const liveLock = await acquireArchiveLock(config.databaseUrl);
    try {
      await expect(exportArchive(config, archive)).rejects.toThrow('正被');
    } finally {
      await liveLock.close();
    }
    const snapshot = await exportArchive(config, archive);
    expect(await inspectArchive(archive)).toEqual(snapshot);
    expect(snapshot.files).toHaveLength(1);
    agent = await boot(config);
    const deletionVersion = (await agent.get(`/api/conversations/${room.id}`).expect(200)).body.data
      .conversation.version;
    const removal = (
      await agent
        .post('/api/lifecycle')
        .send({
          requestId: randomUUID(),
          kind: 'delete_messages',
          conversationId: room.id,
          expectedVersion: deletionVersion,
          messages: [{ messageId: removed.id, contentVersion: removed.contentVersion }],
        })
        .expect(201)
    ).body.data;
    await app!.get(TaskWorkerService).start();
    await completed(agent, removal.id);
    const reset = (
      await agent
        .post('/api/lifecycle')
        .send({
          requestId: randomUUID(),
          kind: 'reset_companion',
          companionId: a.id,
          runtimeEpoch: a.runtimeEpoch,
          expectedVersion: a.version,
        })
        .expect(201)
    ).body.data;
    await completed(agent, reset.id);
    const currentRoom = (await agent.get(`/api/conversations/${room.id}`).expect(200)).body.data
      .conversation;
    await agent
      .post(`/api/conversations/${room.id}/close`)
      .send({ requestId: randomUUID(), expectedConversationVersion: currentRoom.version })
      .expect(200);
    await agent
      .put(`${terminal}/grants`)
      .send({ ...grant, expectedVersion: 1, enabled: false })
      .expect(200);
    await agent.post(`${credential}/revoke`).expect(200);
    expect(
      (await readLifecycleJournal(journal)).records.map((record) => record.action.kind),
    ).toEqual(['lifecycle', 'lifecycle', 'close', 'disable_terminal_grant', 'revoke_terminal']);
    await app!.close();
    app = undefined;
    await expect(
      importArchive(
        { ...restore, lifecycleJournalDir: join(root, 'missing') },
        archive,
        async () => undefined,
      ),
    ).rejects.toThrow();
    await importArchive(restore, archive, (manifest, records) =>
      replayArchive(restore, manifest.ownerId, records),
    );
    await assertRestoreReady(restore.dataDir);
    const report = JSON.parse(await readFile(join(restore.dataDir, 'restore-result.json'), 'utf8'));
    expect(report.appliedJournalRecords).toBe(5);
    agent = await boot(restore);
    expect(
      (await agent.get(`/api/conversations/${room.id}`).expect(200)).body.data.conversation
        .closedAt,
    ).toEqual(expect.any(String));
    const grants = (await agent.get(`${terminal}/grants`).expect(200)).body.data.items;
    expect(grants).toMatchObject([{ enabled: false, version: 2 }]);
    const devices = (await agent.get('/api/terminals').expect(200)).body.data.items;
    expect(devices.find((item: { id: string }) => credential.endsWith(item.id)).state).toBe(
      'revoked',
    );
    const deleted = (
      await agent.get(`/api/conversations/${room.id}/messages/${removed.id}`).expect(200)
    ).body.data;
    expect(deleted).toMatchObject({ deletedAt: expect.any(String), text: '内容已删除' });
    expect(
      (await agent.get(`/api/conversations/${room.id}/messages/${retained.id}`).expect(200)).body
        .data.text,
    ).toBe(retained.text);
    expect((await agent.get(`/api/companions/${a.id}`).expect(200)).body.data.runtimeEpoch).toBe(2);
    expect(
      (await agent.get(`/api/companions/${b.id}`).expect(200)).body.data.currentPersonaVersion,
    ).toEqual(revised);
    expect((await agent.get(`/api/materials/${material.id}/original`).expect(200)).body).toEqual(
      original,
    );
    expect((await agent.get(`/api/tasks/${task.id}`).expect(200)).body.data.status).toBe('queued');
    await app!.get(TaskWorkerService).start();
    await vi.waitFor(
      async () => {
        expect((await agent.get(`/api/tasks/${task.id}`).expect(200)).body.data.status).toBe(
          'succeeded',
        );
      },
      { timeout: 10000, interval: 100 },
    );
    await appendFile(join(archive, 'tables', 'messages.jsonl'), '{}\n');
    await expect(inspectArchive(archive)).rejects.toThrow('校验值不一致');
  } finally {
    await app?.close();
    await target.dispose();
    await source.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 85000);
