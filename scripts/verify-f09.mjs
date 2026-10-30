import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  companionDetailSchema,
  conversationDetailSchema,
  messageSchema,
  chatSchema,
  recallResultSchema,
  modelConfigurationVersionSchema,
  taskConfigurationVersionSchema,
} from '../packages/contracts/dist/index.js';
import { createModelClient, ModelClientError, reportModelClientError } from './model-client.mjs';

let passed = 0;
/** 验收只输出检查结果与本脚本创建的身份。 */
function check(condition, message) {
  if (!condition) throw new ModelClientError(message);
  console.log(`[通过 ${String(++passed).padStart(2, '0')}] ${message}`);
}
/** 创建隔离验收实例，全部请求经过公开 HTTP，不覆盖配置或清理已有数据。 */
async function main() {
  const api = await createModelClient();
  const config = modelConfigurationVersionSchema.parse(await api('/models/config'));
  for (const role of ['chat', 'memory', 'embedding'])
    if (config.config.tasks[role].enabled && config.config.tasks[role].providerId !== 'test')
      throw new ModelClientError(
        '本脚本要求 chat、memory、embedding 使用 test 或停用，请在隔离验收部署运行。',
      );
  if (
    !config.config.tasks.chat.enabled ||
    !taskConfigurationVersionSchema.parse(await api('/tasks/config')).config.enabled
  )
    throw new ModelClientError('需要启用测试聊天模型及任务调度。');
  const create = async (name) =>
    companionDetailSchema.parse(
      await api('/companions', {
        method: 'POST',
        body: { requestId: randomUUID(), name, initialProfile: 'F09 验收，保留独立想法。' },
      }),
    );
  const a = await create('F09 回忆验收 A'),
    b = await create('F09 回忆验收 B');
  const source = conversationDetailSchema.parse(
    await api('/conversations', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        title: 'F09 新补充',
        kind: 'private',
        includeUser: true,
        companions: [{ companionId: a.id, runtimeEpoch: 1 }],
      },
    }),
  ).conversation;
  const draft = messageSchema.parse(
    await api(`/conversations/${source.id}/messages`, {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        speaker: { kind: 'user' },
        text: '我已搬到杭州文三路 18 号。',
        expectedConversationVersion: source.version,
      },
    }),
  );
  await api(`/conversations/${source.id}/messages/${draft.id}/publish`, {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      expectedRevision: draft.revision,
      expectedConversationVersion: source.version,
    },
  });
  const chatFor = async (c) =>
    chatSchema.parse(
      await api('/chats', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          companionId: c.id,
          runtimeEpoch: 1,
          title: 'F09 延续回忆',
        },
      }),
    );
  const chat = await chatFor(a),
    other = await chatFor(b);
  const query = { runtimeEpoch: 1, conversationId: chat.id, query: '给我寄东西用新地址就好。' };
  const recall = recallResultSchema.parse(
    await api(`/companions/${a.id}/recall`, {
      method: 'POST',
      body: { ...query, requestId: randomUUID() },
    }),
  );
  check(
    recall.pending.some((item) => item.messageId === draft.id && item.text === draft.text),
    '普通陈述也能补读另一场私聊的新原文',
  );
  check(recall.coverage.pendingComplete, '待整理覆盖完整且原文没有截断');
  const foreign = recallResultSchema.parse(
    await api(`/companions/${b.id}/recall`, {
      method: 'POST',
      body: { ...query, requestId: randomUUID(), conversationId: other.id },
    }),
  );
  check(!foreign.pending.some((item) => item.messageId === draft.id), 'B 的私聊不能取得 A 的来源');
  await api(`/chats/${chat.id}/messages`, {
    method: 'POST',
    body: { requestId: randomUUID(), text: query.query },
  });
  let complete;
  for (let attempt = 0; attempt < 120; attempt++) {
    complete = chatSchema.parse(await api(`/chats/${chat.id}`));
    if (complete.currentRun?.status === 'succeeded') break;
    if (
      complete.currentRun &&
      ['failed', 'blocked', 'cancelled', 'interrupted', 'paused'].includes(
        complete.currentRun.status,
      )
    )
      throw new ModelClientError('回复未完成，请查看对应任务，不要重复发送。');
    await delay(250);
  }
  check(complete?.currentRun?.status === 'succeeded', '聊天完成并保存固定上下文');
  check(
    complete.currentRun.context.recall?.pending.some((item) => item.messageId === draft.id),
    '跨私聊新补充实际进入本轮模型输入',
  );
  const again = chatSchema.parse(await api(`/chats/${chat.id}`));
  check(
    JSON.stringify(again.currentRun.context.recall) ===
      JSON.stringify(complete.currentRun.context.recall),
    '再次读取保留相同来源快照',
  );
  const current = companionDetailSchema.parse(await api(`/companions/${a.id}`));
  check(
    JSON.stringify(current.initialSnapshot) === JSON.stringify(a.initialSnapshot),
    '回忆没有修改初始人生',
  );
  console.log(`F09 验收完成，共 ${passed} 项。私聊 ${chat.id} 可在网页展开来源。`);
}
await main().catch(reportModelClientError);
