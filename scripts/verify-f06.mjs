import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  companionDetailSchema,
  chatSchema,
  chatMessageListSchema,
  sentChatMessageSchema,
  modelConfigurationVersionSchema,
  taskConfigurationVersionSchema,
} from '../packages/contracts/dist/index.js';
import { createModelClient, ModelClientError, reportModelClientError } from './model-client.mjs';

let passed = 0;
/** 只输出脚本拥有的安全说明，不打印私密原文或凭据。 */
function check(condition, message) {
  if (!condition) throw new ModelClientError(message);
  console.log(`[通过 ${String(++passed).padStart(2, '0')}] ${message}`);
}
/** 有界等待当前轮次，不重发未知调用。 */
async function ready(api, id) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const chat = chatSchema.parse(await api(`/chats/${id}`));
    if (chat.currentRun?.status === 'succeeded') return chat;
    if (
      chat.currentRun &&
      ['failed', 'blocked', 'cancelled', 'interrupted', 'paused'].includes(chat.currentRun.status)
    )
      throw new ModelClientError(`回复 ${chat.currentRun.id} 未完成，请查看其任务状态。`);
    await delay(500);
  }
  throw new ModelClientError('回复仍在等待，请查看页面和持久任务，不要重复创建。');
}
/** 保存一位验收伴侣、一个私聊及两条用户原文，不改部署者配置或删除已有数据。 */
async function main() {
  const api = await createModelClient();
  const config = modelConfigurationVersionSchema.parse(await api('/models/config'));
  if (config.config.tasks.chat.providerId !== 'test')
    throw new ModelClientError('本脚本只允许 chat 使用 test，不会切换你的模型或发起付费调用。');
  if (!taskConfigurationVersionSchema.parse(await api('/tasks/config')).config.enabled)
    throw new ModelClientError('任务调度已停用，请按实际需要启用后再验收。');
  const companion = companionDetailSchema.parse(
    await api('/companions', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: 'F06 验收 · 海边来客',
        initialProfile: '出生在海边，喜欢散步，保留独立思考。',
      },
    }),
  );
  const create = {
    requestId: randomUUID(),
    companionId: companion.id,
    runtimeEpoch: companion.runtimeEpoch,
    title: 'F06 验收私聊',
  };
  const chat = chatSchema.parse(await api('/chats', { method: 'POST', body: create }));
  check(
    chat.companionId === companion.id && chat.currentRun === null,
    '新私聊绑定确切伴侣和代次，查看不触发回复',
  );
  const replayChat = chatSchema.parse(await api('/chats', { method: 'POST', body: create }));
  check(replayChat.id === chat.id, '创建重试复用原会话');
  const first = { requestId: randomUUID(), text: '之前我住在上海。' };
  const saved = sentChatMessageSchema.parse(
    await api(`/chats/${chat.id}/messages`, { method: 'POST', body: first }),
  );
  check(
    saved.message.state === 'published' && saved.message.sequence === 1,
    'HTTP 返回前原文已经正式保存',
  );
  const replay = sentChatMessageSchema.parse(
    await api(`/chats/${chat.id}/messages`, { method: 'POST', body: first }),
  );
  check(
    replay.message.id === saved.message.id && replay.run.id === saved.run.id,
    '同一次发送重试不复制原文或任务',
  );
  const second = sentChatMessageSchema.parse(
    await api(`/chats/${chat.id}/messages`, {
      method: 'POST',
      body: { requestId: randomUUID(), text: '补充：现在已经搬到杭州。' },
    }),
  );
  const completed = await ready(api, chat.id);
  check(
    completed.currentRun.id === second.run.id && completed.currentRun.mode === 'test',
    '最新一轮完成并明确标记测试模型',
  );
  check(
    completed.currentRun.context.sources.some((item) => item.messageId === second.message.id),
    '新补充原文直接进入上下文',
  );
  check(
    completed.currentRun.context.personaVersionId === companion.currentPersonaVersion.id,
    '上下文使用当前人格版本',
  );
  let history = chatMessageListSchema.parse(await api(`/chats/${chat.id}/messages`));
  check(
    history.items.filter((item) => item.message.speaker.kind === 'user').length === 2,
    '用户原文只有两条，没有网络重试副本',
  );
  const reply = history.items.filter((item) => item.runId === second.run.id);
  check(
    reply.length > 0 && reply.every((item) => item.message.sourceKind === 'model_output'),
    '回复以模型来源正式发布并绑定轮次',
  );
  check(
    reply.map((item) => item.message.text).join('') === '测试模型已收到：补充：现在已经搬到杭州。',
    '已发布片段可重建完整测试回复',
  );
  check(
    history.items.every((item) => item.deliveredAt === null),
    '查询历史不会冒充终端送达',
  );
  await api(`/chats/${chat.id}/deliveries`, {
    method: 'POST',
    body: {
      terminalId: randomUUID(),
      messages: [{ messageId: saved.message.id, contentVersion: saved.message.contentVersion }],
    },
  });
  history = chatMessageListSchema.parse(await api(`/chats/${chat.id}/messages`));
  check(
    history.items.find((item) => item.message.id === saved.message.id).deliveredAt !== null &&
      history.items.find((item) => item.message.id === second.message.id).deliveredAt === null,
    '回执只确认指定原文，没有跨越未确认消息',
  );
  const again = chatSchema.parse(await api(`/chats/${chat.id}`));
  check(
    again.currentRun.id === completed.currentRun.id && again.currentRun.status === 'succeeded',
    '重复查询保留同一持久结果',
  );
  console.log(`验收完成：${passed} 项。保留伴侣 ${companion.id}，私聊 ${chat.id} 供页面检查。`);
}
main().catch(reportModelClientError);
