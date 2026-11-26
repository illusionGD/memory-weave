import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  API_CODES,
  conversationDetailSchema,
  invitationSchema,
  publishedMessageSchema,
} from '@memory-weave/contracts';
import type { Invitation, PublishedMessage } from '@memory-weave/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app';
import { TaskWorkerService } from '../src/modules/tasks/task-worker.service';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';
import { createTestAuthConfig, disposeTestAuth } from './support/redis';

afterAll(disposeTestAuth);

describe('F17 会话成员与历史授权', () => {
  let app: INestApplication;
  let database: TestDatabase;
  let directory: string;
  let owner: ReturnType<typeof request.agent>;

  beforeEach(async () => {
    database = await createTestDatabase();
    directory = await mkdtemp(join(tmpdir(), 'memory-weave-membership-'));
    app = await createApplication({
      host: '127.0.0.1',
      port: 0,
      databaseUrl: database.databaseUrl,
      qdrantUrl: 'http://127.0.0.1:1',
      qdrantApiKey: 'isolated-vector-key',
      ...createTestAuthConfig(),
      adminPassword: 'membership-test-password',
      appOrigin: 'http://localhost:5173',
      cookieSecure: false,
      dataDir: directory,
      webDistDir: null,
    });
    owner = request.agent(app.getHttpServer());
    await owner.post('/api/auth/login').send({ password: 'membership-test-password' }).expect(200);
  }, 30000);

  afterEach(async () => {
    await app?.close();
    await database?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30000);

  /** 创建可参与本部署会话的独立伴侣。 */
  async function companion(name: string): Promise<string> {
    return (
      await owner
        .post('/api/companions')
        .send({
          requestId: randomUUID(),
          name,
          initialProfile: '遵守明确范围。',
        })
        .expect(201)
    ).body.data.id;
  }

  /** 查询共享会话和当前成员版本。 */
  async function conversation(id: string) {
    return conversationDetailSchema.parse(
      (await owner.get(`/api/conversations/${id}`).expect(200)).body.data,
    );
  }

  /** 用公开的草稿发布协议产生真实历史。 */
  async function publish(id: string, text: string): Promise<PublishedMessage> {
    const { version } = (await conversation(id)).conversation;
    const draft = (
      await owner
        .post(`/api/conversations/${id}/messages`)
        .send({
          requestId: randomUUID(),
          speaker: { kind: 'user' },
          expectedConversationVersion: version,
          text,
        })
        .expect(201)
    ).body.data;
    return publishedMessageSchema.parse(
      (
        await owner
          .post(`/api/conversations/${id}/messages/${draft.id}/publish`)
          .send({
            requestId: randomUUID(),
            expectedRevision: draft.revision,
            expectedConversationVersion: version,
          })
          .expect(201)
      ).body.data,
    );
  }

  /** 根据当前发布边界创建邀请。 */
  async function invite(
    id: string,
    companionId: string,
    restoreRemoved = false,
    expectedStatus = 201,
  ) {
    const expectedConversationVersion = (await conversation(id)).conversation.version;
    const response = await owner
      .post(`/api/conversations/${id}/invitations`)
      .send({
        requestId: randomUUID(),
        expectedConversationVersion,
        companionId,
        runtimeEpoch: 1,
        restoreRemoved,
      })
      .expect(expectedStatus);
    return expectedStatus === 201 ? invitationSchema.parse(response.body.data) : undefined;
  }

  /** 保存决定并验证幂等重放。 */
  async function decide(invitation: Invitation, decision: 'accept' | 'defer' | 'decline') {
    const command = { requestId: randomUUID(), expectedVersion: invitation.version, decision };
    const path = `/api/conversations/${invitation.conversationId}/invitations/${invitation.id}/decision`;
    const first = invitationSchema.parse(
      (await owner.post(path).send(command).expect(200)).body.data,
    );
    expect((await owner.post(path).send(command).expect(200)).body.data).toEqual(first);
    return first;
  }

  /** 通过伴侣自己的访问范围读取原文序号。 */
  async function visible(companionId: string, id: string, status = 200): Promise<number[]> {
    const result = await owner
      .get(`/api/companions/${companionId}/conversations/${id}/messages?runtimeEpoch=1`)
      .expect(status);
    return status === 200
      ? result.body.data.items.map((row: PublishedMessage) => row.sequence)
      : [];
  }

  it('新成员默认只读入群以后，历史明确批准和撤销，重新加入保留旧窗口但跳过缺席区间', async () => {
    const a = await companion('阿澜');
    const b = await companion('阿溪');
    const c = await companion('小雨');
    const group = (
      await owner
        .post('/api/conversations')
        .send({
          requestId: randomUUID(),
          kind: 'group',
          title: '共享范围',
          includeUser: true,
          companions: [a, b].map((companionId) => ({ companionId, runtimeEpoch: 1 })),
        })
        .expect(201)
    ).body.data.conversation.id as string;
    await publish(group, '第一条旧原文。');
    await publish(group, '第二条旧原文。');
    const pending = (await invite(group, c))!;
    expect(pending.state).toBe('pending');
    await visible(c, group, 404);
    const deferred = await decide(pending, 'defer');
    expect(deferred.state).toBe('deferred');
    await visible(c, group, 404);
    expect(await decide(deferred, 'accept')).toMatchObject({
      acceptedConversationId: group,
      decidedBy: 'owner',
    });
    let member = (await conversation(group)).members.find((row) => row.companionId === c)!;
    expect(member).toMatchObject({ joinedSequence: 3, leftSequence: null, permissionVersion: 1 });
    expect(await visible(c, group)).toEqual([]);
    await publish(group, '第三条入群后原文。');
    expect(await visible(c, group)).toEqual([3]);
    const rawHistory = `/api/conversations/${group}/history-requests`;
    const proposed = (
      await owner
        .post(rawHistory)
        .send({
          requestId: randomUUID(),
          membershipId: member.id,
          expectedPermissionVersion: member.permissionVersion,
          range: { from: 1, through: 1 },
        })
        .expect(201)
    ).body.data;
    expect(proposed.state).toBe('pending');
    expect(await visible(c, group)).toEqual([3]);
    const approval = (
      await owner
        .post(`${rawHistory}/${proposed.id}/decision`)
        .send({
          requestId: randomUUID(),
          expectedVersion: proposed.version,
          decision: 'approve',
        })
        .expect(200)
    ).body.data;
    expect(approval).toMatchObject({ state: 'approved', queuedMessages: 1, permissionVersion: 2 });
    expect(await visible(c, group)).toEqual([1, 3]);
    expect(await visible(a, group)).toEqual([1, 2, 3]);
    const progress = (
      await owner
        .get(`/api/companions/${c}/conversations/${group}/progress?runtimeEpoch=1`)
        .expect(200)
    ).body.data;
    expect(progress.items.map((item: { sequence: number }) => item.sequence)).toEqual([1, 3]);
    await owner
      .post(`${rawHistory}/${proposed.id}/decision`)
      .send({
        requestId: randomUUID(),
        expectedVersion: approval.version,
        decision: 'revoke',
      })
      .expect(200);
    expect(await visible(c, group)).toEqual([3]);
    member = (await conversation(group)).members.find((row) => row.companionId === c)!;
    const exitCommand = {
      requestId: randomUUID(),
      expectedConversationVersion: (await conversation(group)).conversation.version,
      expectedPermissionVersion: member.permissionVersion,
    };
    const exitPath = `/api/conversations/${group}/members/${member.id}/exit`;
    const exited = (await owner.post(exitPath).send(exitCommand).expect(200)).body.data;
    expect(exited).toMatchObject({ removed: true, leftSequence: 3 });
    expect((await owner.post(exitPath).send(exitCommand).expect(200)).body.data).toEqual(exited);
    await publish(group, '离开后的新消息。');
    expect(await visible(c, group)).toEqual([3]);
    await invite(group, c, false, 403);
    await decide((await invite(group, c, true))!, 'accept');
    expect((await conversation(group)).members.find((row) => row.companionId === c)).toMatchObject({
      id: member.id,
      joinedSequence: 5,
      leftSequence: null,
      removedAt: null,
    });
    await publish(group, '重新入群后的交流。');
    expect(await visible(c, group)).toEqual([3, 5]);
  }, 40000);

  it('扩展私聊只新建群，背景只公开取得授权的引文，原文删除后撤回派生片段', async () => {
    const a = await companion('阿澜');
    const b = await companion('阿溪');
    const privateId = (
      await owner
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          companionId: a,
          runtimeEpoch: 1,
          title: '私有会话',
        })
        .expect(201)
    ).body.data.id as string;
    const privateMessage = (
      await owner
        .post(`/api/chats/${privateId}/messages`)
        .send({
          requestId: randomUUID(),
          text: '公开这一句。其余留在原会话。',
        })
        .expect(201)
    ).body.data.message;
    const group = (await decide((await invite(privateId, b))!, 'accept')).acceptedConversationId!;
    expect(group).not.toBe(privateId);
    expect((await conversation(privateId)).members).toHaveLength(2);
    expect((await conversation(group)).members).toHaveLength(3);
    expect(await visible(b, group)).toEqual([]);
    await visible(b, privateId, 404);
    const lookup = `/api/companions/${b}/sources/${privateMessage.id}?runtimeEpoch=1&contentVersion=1`;
    await owner.get(lookup).expect(404);
    const input = {
      requestId: randomUUID(),
      expectedConversationVersion: (await conversation(group)).conversation.version,
      sourceConversationId: privateId,
      messageId: privateMessage.id,
      contentVersion: privateMessage.contentVersion,
      startOffset: 0,
      endOffset: '公开这一句。'.length,
    };
    const backgroundPath = `/api/conversations/${group}/background`;
    const excerpt = (await owner.post(backgroundPath).send(input).expect(201)).body.data;
    expect(excerpt).toMatchObject({
      text: '公开这一句。',
      epistemicKind: 'report',
      sources: [{ messageId: privateMessage.id, relation: 'report' }],
    });
    expect((await owner.post(backgroundPath).send(input).expect(201)).body.data.id).toBe(
      excerpt.id,
    );
    await owner
      .post(backgroundPath)
      .send({ ...input, endOffset: input.endOffset + 1 })
      .expect(409);
    expect(await visible(b, group)).toEqual([1]);
    await owner.get(lookup).expect(404);

    const privateVersion = (await conversation(privateId)).conversation.version;
    const operation = (
      await owner
        .post('/api/lifecycle')
        .send({
          requestId: randomUUID(),
          kind: 'delete_messages',
          conversationId: privateId,
          expectedVersion: privateVersion,
          messages: [
            { messageId: privateMessage.id, contentVersion: privateMessage.contentVersion },
          ],
        })
        .expect(201)
    ).body.data;
    await app.get(TaskWorkerService).start();
    await vi.waitFor(
      async () => {
        expect(
          (await owner.get(`/api/lifecycle/${operation.id}`).expect(200)).body.data.status,
        ).toBe('completed');
      },
      { timeout: 15000, interval: 100 },
    );
    expect(await visible(b, group)).toEqual([]);
  }, 40000);

  it('空会话退出边界为零，结束私聊保留历史入口并拒绝新发送', async () => {
    const a = await companion('阿澜');
    const id = (
      await owner
        .post('/api/chats')
        .send({
          requestId: randomUUID(),
          companionId: a,
          runtimeEpoch: 1,
          title: '关闭范围',
        })
        .expect(201)
    ).body.data.id as string;
    const current = await conversation(id);
    const member = current.members.find((row) => row.companionId === a)!;
    const result = await owner
      .post(`/api/conversations/${id}/members/${member.id}/exit`)
      .send({
        requestId: randomUUID(),
        expectedConversationVersion: current.conversation.version,
        expectedPermissionVersion: member.permissionVersion,
      })
      .expect(200);
    expect(result.body.data.leftSequence).toBe(0);
    expect((await conversation(id)).conversation.closedAt).toEqual(expect.any(String));
    expect((await owner.get(`/api/chats/${id}`).expect(200)).body.data.availability).toBe(
      'archived',
    );
    await owner.get(`/api/chats/${id}/messages`).expect(200);
    expect(
      (
        await owner
          .post(`/api/chats/${id}/messages`)
          .send({
            requestId: randomUUID(),
            text: '关闭后不能发布。',
          })
          .expect(409)
      ).body.code,
    ).toBe(API_CODES.CONVERSATION_CLOSED);
  }, 30000);
});
