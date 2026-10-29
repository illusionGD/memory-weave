import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  companionDetailSchema,
  conversationDetailSchema,
  messageSchema,
  memoryBatchResultSchema,
  memoryBatchListSchema,
  memoryListSchema,
  conversationProgressResponseSchema,
  modelConfigurationVersionSchema,
  taskConfigurationVersionSchema,
  taskSchema,
} from '../packages/contracts/dist/index.js';
import { createModelClient, ModelClientError, reportModelClientError } from './model-client.mjs';

let passed = 0;
/** 输出验收结论和脚本创建的身份，不记录私有原文或凭据。 */
function check(condition, message) {
  if (!condition) throw new ModelClientError(message);
  console.log(`[通过 ${String(++passed).padStart(2, '0')}] ${message}`);
}
/** 只执行 test 记忆任务，不切换真实模型或清理部署者数据。 */
async function main() {
  const api = await createModelClient();
  const config = modelConfigurationVersionSchema.parse(await api('/models/config'));
  if (config.config.tasks.memory.providerId !== 'test' || !config.config.tasks.memory.enabled)
    throw new ModelClientError(
      '本脚本要求 memory 已启用且使用 test，不会切换真实模型或发起付费调用。',
    );
  if (!taskConfigurationVersionSchema.parse(await api('/tasks/config')).config.enabled)
    throw new ModelClientError('调度已关闭，请启用后验收。');
  const create = async (name) =>
    companionDetailSchema.parse(
      await api('/companions', {
        method: 'POST',
        body: { requestId: randomUUID(), name, initialProfile: 'F08 验收初始人生，保留独立想法。' },
      }),
    );
  const a = await create('F08 记忆验收 A');
  const b = await create('F08 记忆验收 B');
  const conversation = conversationDetailSchema.parse(
    await api('/conversations', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        title: 'F08 整理验收',
        kind: 'group',
        includeUser: true,
        companions: [a, b].map((c) => ({ companionId: c.id, runtimeEpoch: c.runtimeEpoch })),
      },
    }),
  ).conversation;
  for (const text of ['早上好，今天就随便聊聊。', '好的，这是一段验收闲聊。']) {
    const current = conversationDetailSchema.parse(
      await api(`/conversations/${conversation.id}`),
    ).conversation;
    const draft = messageSchema.parse(
      await api(`/conversations/${conversation.id}/messages`, {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          speaker: { kind: 'user' },
          expectedConversationVersion: current.version,
          text,
        },
      }),
    );
    await api(`/conversations/${conversation.id}/messages/${draft.id}/publish`, {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        expectedConversationVersion: current.version,
        expectedRevision: draft.revision,
      },
    });
  }
  const path = `/companions/${a.id}/memories`;
  const query = `runtimeEpoch=1&conversationId=${conversation.id}&limit=100`;
  const command = { requestId: randomUUID(), runtimeEpoch: 1, conversationId: conversation.id };
  const batch = memoryBatchResultSchema.parse(
    await api(`${path}/organize`, { method: 'POST', body: command }),
  );
  check(batch.sourceCount === 2 && batch.taskId, '两条原文固定为同一批次');
  const replay = memoryBatchResultSchema.parse(
    await api(`${path}/organize`, { method: 'POST', body: command }),
  );
  check(replay.id === batch.id && replay.taskId === batch.taskId, '命令重试复用批次与任务');
  let task;
  for (let i = 0; i < 120; i++) {
    task = taskSchema.parse(await api(`/tasks/${batch.taskId}`));
    if (task.status === 'succeeded') break;
    if (['failed', 'cancelled', 'blocked', 'paused'].includes(task.status))
      throw new ModelClientError(`记忆任务 ${task.id} 未完成，请查看整理记录。`);
    await delay(250);
  }
  check(task?.status === 'succeeded', '后台任务完成并保存模型结果');
  const batches = memoryBatchListSchema.parse(await api(`${path}/batches?${query}`));
  const completed = batches.items.find((row) => row.id === batch.id);
  check(
    completed?.mode === 'test' && completed.outcomes?.defer === 2,
    '测试模式零候选也记录处理结果',
  );
  const list = memoryListSchema.parse(await api(`${path}?${query}`));
  check(list.items.length === 0, '没有把闲聊强行编造成长期事实');
  const progress = conversationProgressResponseSchema.parse(
    await api(`/companions/${a.id}/conversations/${conversation.id}/progress?runtimeEpoch=1`),
  );
  check(
    progress.items.length === 2 && progress.items.every((row) => row.processing === 'processed'),
    'A 的两个确切范围已完成',
  );
  const other = conversationProgressResponseSchema.parse(
    await api(`/companions/${b.id}/conversations/${conversation.id}/progress?runtimeEpoch=1`),
  );
  const otherBatches = memoryBatchListSchema.parse(
    await api(`/companions/${b.id}/memories/batches?${query}`),
  );
  check(
    other.items.length === 2 &&
      otherBatches.items.every((row) => row.id !== batch.id) &&
      (otherBatches.items.length > 0 || other.items.every((row) => row.processing === 'pending')),
    'B 保留自己的范围及批次，不复用 A 的完成状态',
  );
  const current = companionDetailSchema.parse(await api(`/companions/${a.id}`));
  check(
    JSON.stringify(current.initialSnapshot) === JSON.stringify(a.initialSnapshot),
    '整理没有改写初始人生',
  );
  console.log(`F08 验收完成，共 ${passed} 项。批次 ${batch.id}，伴侣 ${a.id}。`);
}
await main().catch(reportModelClientError);
