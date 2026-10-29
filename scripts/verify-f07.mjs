import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  companionDetailSchema,
  conversationDetailSchema,
  messageSchema,
  lifecycleOperationSchema,
  taskConfigurationVersionSchema,
  modelConfigurationVersionSchema,
} from '../packages/contracts/dist/index.js';
import { createModelClient, ModelClientError, reportModelClientError } from './model-client.mjs';

let passed = 0;
/** 只打印验收状态与本脚本创建的身份，不输出正文或凭据。 */
function check(value, description) {
  if (!value) throw new ModelClientError(description);
  console.log(`[通过 ${String(++passed).padStart(2, '0')}] ${description}`);
}
/** 从持久记录等待清理，不自动恢复失败或扩展目标。 */
async function finish(api, operation) {
  for (let i = 0; i < 120; i++) {
    const current = lifecycleOperationSchema.parse(await api(`/lifecycle/${operation.id}`));
    if (current.status === 'completed') return current;
    if (['failed', 'cancelled', 'blocked', 'paused'].includes(current.task.status))
      throw new ModelClientError(`清理 ${current.id} 尚未完成，请查看清理记录。`);
    await delay(250);
  }
  throw new ModelClientError(`清理 ${operation.id} 仍在等待，请查看清理记录。`);
}
/** 所有删除目标都来自本次创建返回值；不直接调用模型、不改变部署配置；F08 后台最多使用 test。 */
async function main() {
  const api = await createModelClient();
  const memory = modelConfigurationVersionSchema.parse(await api('/models/config')).config.tasks
    .memory;
  if (memory.enabled && memory.providerId !== 'test')
    throw new ModelClientError(
      '记忆后台使用真实模型，请在隔离验收部署运行本脚本，避免测试原文触发真实提取。',
    );
  if (!taskConfigurationVersionSchema.parse(await api('/tasks/config')).config.enabled)
    throw new ModelClientError('调度已停用，请按实际需要启用后再验收。');
  const create = async (name) =>
    companionDetailSchema.parse(
      await api('/companions', {
        method: 'POST',
        body: { requestId: randomUUID(), name, initialProfile: 'F07 验收初始人生。' },
      }),
    );
  const a = await create('F07 验收 A');
  const b = await create('F07 验收 B');
  const group = conversationDetailSchema.parse(
    await api('/conversations', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        title: 'F07 验收共同原文',
        kind: 'group',
        includeUser: true,
        companions: [a, b].map((c) => ({ companionId: c.id, runtimeEpoch: c.runtimeEpoch })),
      },
    }),
  ).conversation;
  const publish = async (text, speaker, sources = []) => {
    const detail = conversationDetailSchema.parse(await api(`/conversations/${group.id}`));
    const draft = messageSchema.parse(
      await api(`/conversations/${group.id}/messages`, {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          speaker,
          expectedConversationVersion: detail.conversation.version,
          text,
          sources,
        },
      }),
    );
    return messageSchema.parse(
      await api(`/conversations/${group.id}/messages/${draft.id}/publish`, {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          expectedConversationVersion: detail.conversation.version,
          expectedRevision: draft.revision,
        },
      }),
    );
  };
  const first = await publish('验收需要清理的共同原文。', {
    kind: 'companion',
    companionId: a.id,
    runtimeEpoch: 1,
  });
  const copy = await publish(
    '验收转述：需要清理的共同原文。',
    { kind: 'companion', companionId: b.id, runtimeEpoch: 1 },
    [{ messageId: first.id, contentVersion: first.contentVersion, relation: 'report' }],
  );
  const independent = await publish('验收独立原文。', { kind: 'user' });
  const resetCommand = {
    requestId: randomUUID(),
    kind: 'reset_companion',
    companionId: a.id,
    runtimeEpoch: a.runtimeEpoch,
    expectedVersion: a.version,
  };
  const reset = lifecycleOperationSchema.parse(
    await api('/lifecycle', { method: 'POST', body: resetCommand }),
  );
  check(reset.nextEpoch === 2, '重置更新代次，先持久保存限制');
  await finish(api, reset);
  const current = companionDetailSchema.parse(await api(`/companions/${a.id}`));
  check(current.initialSnapshot.profileText === a.initialSnapshot.profileText, '重置保留初始人生');
  check(
    (await api('/lifecycle', { method: 'POST', body: resetCommand })).id === reset.id,
    '同键重试没有再次重置',
  );
  const deleteA = lifecycleOperationSchema.parse(
    await api('/lifecycle', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        kind: 'delete_companion',
        companionId: current.id,
        runtimeEpoch: current.runtimeEpoch,
        expectedVersion: current.version,
      },
    }),
  );
  await finish(api, deleteA);
  let missing = false;
  try {
    await api(`/companions/${a.id}`);
  } catch (error) {
    if (!(error instanceof ModelClientError) || error.status !== 404) throw error;
    missing = true;
  }
  check(missing, '删除实例后私有资料不可读取');
  const remainingB = companionDetailSchema.parse(await api(`/companions/${b.id}`));
  check(JSON.stringify(remainingB) === JSON.stringify(b), '另一实例的人格及代次未改变');
  let detail = conversationDetailSchema.parse(await api(`/conversations/${group.id}`));
  check(
    detail.members.some((m) => m.kind === 'companion' && m.companionId === a.id && m.deletedAt),
    '共同历史中保留已删除参与者标记',
  );
  const read = async (id) =>
    messageSchema.parse(await api(`/conversations/${group.id}/messages/${id}`));
  check((await read(first.id)).text === first.text, '删除实例仍保留已发布的共同原文');
  const removeMessages = async (targets) => {
    detail = conversationDetailSchema.parse(await api(`/conversations/${group.id}`));
    const operation = lifecycleOperationSchema.parse(
      await api('/lifecycle', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          kind: 'delete_messages',
          conversationId: group.id,
          expectedVersion: detail.conversation.version,
          messages: targets.map((m) => ({ messageId: m.id, contentVersion: m.contentVersion })),
        },
      }),
    );
    return finish(api, operation);
  };
  const cleared = await removeMessages([first]);
  check(
    cleared.completedStages === cleared.totalStages && cleared.processedRecords > 0,
    '清理记录报告实际完成阶段与处理数量',
  );
  check(
    (await read(first.id)).deletedAt !== null && (await read(first.id)).text === '内容已删除',
    '明确选中的原文正文已清除',
  );
  check((await read(copy.id)).deletedAt !== null, '转述沿来源一同清除');
  check((await read(independent.id)).text === independent.text, '没有误删独立原文');
  await removeMessages([independent]);
  await finish(
    api,
    lifecycleOperationSchema.parse(
      await api('/lifecycle', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          kind: 'delete_companion',
          companionId: b.id,
          runtimeEpoch: b.runtimeEpoch,
          expectedVersion: b.version,
        },
      }),
    ),
  );
  check(true, '仅清理本次脚本创建的两个实例和原文，保留验收操作日志');
  console.log(`验收完成：${passed} 项。共同会话 ${group.id} 及清理记录可供检查。`);
}
main().catch(reportModelClientError);
