import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  taskSchema,
  taskConfigurationVersionSchema,
  modelConfigurationVersionSchema,
  modelUsageSchema,
  modelCallSchema,
  taskListSchema,
} from '../packages/contracts/dist/index.js';
import { createModelClient, ModelClientError, reportModelClientError } from './model-client.mjs';

let passed = 0;
/** 通过真实 HTTP 检查持久行为，不输出任务输入或凭据。 */
function check(condition, message) {
  if (!condition) throw new ModelClientError(message);
  passed += 1;
  console.log(`[通过 ${String(passed).padStart(2, '0')}] ${message}`);
}

/** 等待实际状态，有界超时后保留任务 ID 供后续查询，不创建替代任务。 */
async function waitTask(api, id) {
  for (let i = 0; i < 120; i += 1) {
    const task = taskSchema.parse(await api(`/tasks/${id}`));
    if (task.status === 'succeeded') return task;
    if (['failed', 'blocked', 'cancelled', 'paused'].includes(task.status))
      throw new ModelClientError(
        `任务 ${id} 进入 ${task.status}，原因 ${task.reason ?? '未提供'}。`,
      );
    await delay(500);
  }
  throw new ModelClientError(
    `任务 ${id} 尚未完成，请运行 pnpm tasks:config get ${id} 检查 worker。`,
  );
}

/** 创建两条永久隔离诊断，模型只允许 test；不改配置、不暂停其他任务。 */
async function main() {
  const api = await createModelClient();
  const settings = taskConfigurationVersionSchema.parse(await api('/tasks/config'));
  if (!settings.config.enabled)
    throw new ModelClientError('调度已停用，请先按实际需求启用配置；验收不会替你修改。');
  const modelConfig = modelConfigurationVersionSchema.parse(await api('/models/config'));
  if (modelConfig.config.tasks.chat.providerId !== 'test')
    throw new ModelClientError('本验收仅允许 chat 使用 test，不会修改真实模型配置或发起付费请求。');
  check(settings.version > 0, '调度配置可查询且带持久版本');
  const before = modelUsageSchema.parse(await api('/models/usage'));
  const diagnostic = { requestId: randomUUID(), steps: 3 };
  const queued = taskSchema.parse(
    await api('/tasks/diagnostics', { method: 'POST', body: diagnostic }),
  );
  console.log(`步骤诊断：${queued.id}`);
  const replay = taskSchema.parse(
    await api('/tasks/diagnostics', { method: 'POST', body: diagnostic }),
  );
  check(replay.id === queued.id, '重复创建返回相同任务身份');
  let conflict = false;
  try {
    await api('/tasks/diagnostics', { method: 'POST', body: { ...diagnostic, steps: 4 } });
  } catch (error) {
    if (error instanceof ModelClientError && error.code === 40901) conflict = true;
    else throw error;
  }
  check(conflict, '同键不同输入被拒绝');
  const finished = await waitTask(api, queued.id);
  check(
    finished.progress.completedSteps === 3 && finished.progress.totalSteps === 3,
    '自动 worker 完成并保存三个实际步骤',
  );
  check(
    finished.attempts.some((attempt) => attempt.status === 'succeeded'),
    '领取配置和尝试结果可追溯',
  );
  const cancelled = taskSchema.parse(
    await api(`/tasks/${finished.id}/cancel`, { method: 'POST', body: {} }),
  );
  check(cancelled.status === 'succeeded', '已完成任务不会因迟到取消而撤销成果');
  const modelCommand = {
    requestId: randomUUID(),
    expectedConfigVersion: modelConfig.version,
    role: 'chat',
    operation: 'structured',
    inputText: 'F04 后台恢复诊断',
  };
  const modelTask = taskSchema.parse(
    await api('/tasks/model-probes', { method: 'POST', body: modelCommand }),
  );
  console.log(`模型诊断：${modelTask.id}`);
  const modelDone = await waitTask(api, modelTask.id);
  const call = modelCallSchema.parse(await api(`/models/calls/${modelDone.modelCallId}`));
  check(call.status === 'succeeded' && call.lane === 'background', '模型任务通过 F03 后台容量执行');
  check(
    modelDone.progress.completedSteps === 1 && modelDone.modelCallId === call.id,
    '任务进度与已保存模型结果关联',
  );
  const modelReplay = taskSchema.parse(
    await api('/tasks/model-probes', { method: 'POST', body: modelCommand }),
  );
  check(
    modelReplay.id === modelDone.id && modelReplay.modelCallId === call.id,
    '模型任务重放复用已有结果',
  );
  const after = modelUsageSchema.parse(await api('/models/usage'));
  check(
    after.global.charged.requests - before.global.charged.requests === 1,
    '整个验收只占用一次测试模型调用，任务重放不再次计量',
  );
  const list = taskListSchema.parse(await api('/tasks?status=succeeded&limit=1'));
  check(list.items.length === 1 && list.items[0].status === 'succeeded', '状态筛选和有界分页可用');
  console.log(
    `F04 验收完成：${passed} 项通过。两条诊断已持久保存；进程强杀、租约竞争与故障回滚由隔离测试验证。`,
  );
}
await main().catch(reportModelClientError);
