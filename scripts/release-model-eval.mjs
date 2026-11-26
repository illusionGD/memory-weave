import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const base = new URL(process.env.F24_BASE_URL ?? 'http://127.0.0.1:3000');
const password = process.env.F24_ADMIN_PASSWORD;
const cap = Number(process.env.F24_MODEL_BUDGET_MICROS ?? 0);
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
  !password ||
  !Number.isSafeInteger(cap) ||
  cap <= 0
)
  throw new Error('请使用独立评估部署的本地端口、登录密码和允许支出的微美元上限。');
let cookie = '';

/** 请求实际 HTTP 业务接口并记录可审查的状态。 */
async function api(path, method = 'GET', body) {
  const response = await fetch(new URL(`/api${path}`, base), {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${method} ${path} HTTP ${response.status} (${result.code})`);
  cookie ||= response.headers.get('set-cookie')?.split(';')[0] ?? '';
  return result.data;
}

/** 等待真实后台任务成功并返回实际业务结果。 */
async function finish(id) {
  for (let i = 0; i < 180; i++) {
    const task = await api(`/tasks/${id}`);
    if (task.status === 'succeeded') return task;
    if (['failed', 'blocked', 'cancelled'].includes(task.status))
      throw new Error(`评估任务 ${task.status} (${task.reason})。`);
    await delay(500);
  }
  throw new Error('真实模型任务等待超时。');
}

/** 创建互相隔离的实例与源会话。 */
async function companion(name) {
  return api('/companions', 'POST', {
    requestId: randomUUID(),
    name,
    initialProfile: '这是隔离评估中的虚构伴侣。保留事实出处，信息不充分时明确说明未知。',
  });
}

/** 保存确切的用户原文和现实范围。 */
async function publish(room, text, fiction = false) {
  const { conversation } = await api(`/conversations/${room}`);
  const fields = { expectedConversationVersion: conversation.version };
  const draft = await api(`/conversations/${room}/messages`, 'POST', {
    ...fields,
    requestId: randomUUID(),
    speaker: { kind: 'user' },
    text,
    ...(fiction ? { reality: 'fictional', epistemicKind: 'setting' } : { reality: 'real' }),
  });
  return api(`/conversations/${room}/messages/${draft.id}/publish`, 'POST', {
    ...fields,
    requestId: randomUUID(),
    expectedRevision: draft.revision,
  });
}

/** 使用实际当前模型完成响应，返回确切上下文和已发布回复。 */
async function reply(chat, text) {
  const start = performance.now();
  const sent = await api(`/chats/${chat}/messages`, 'POST', { requestId: randomUUID(), text });
  const task = await finish(sent.run.id);
  const run = await api(`/management/chats/${chat}/runs/${sent.run.id}`);
  const history = await api(`/chats/${chat}/messages`);
  const textOutput = history.items
    .filter((item) => item.runId === sent.run.id)
    .map((item) => item.message.text)
    .join('');
  return {
    taskId: task.id,
    ms: Math.round(performance.now() - start),
    output: textOutput,
    recall: run.context?.recall?.memories ?? [],
    pending: run.context?.recall?.pending ?? [],
  };
}

await api('/auth/login', 'POST', { password });
const [configuration, before, existing] = await Promise.all([
  api('/models/config'),
  api('/models/usage'),
  api('/companions?limit=1'),
]);
if (existing.items.length || before.global.charged.requests !== 0)
  throw new Error('请在本日未执行模型请求的全新隔离部署运行。');
if (configuration.config.dailyBudget.costMicros > cap)
  throw new Error('部署的全局费用上限超过显式批准金额。');
for (const role of ['chat', 'memory', 'embedding']) {
  const model = configuration.config.tasks[role];
  if (
    !model.enabled ||
    model.providerId === 'test' ||
    model.inputMicrosPerMillion === null ||
    model.outputMicrosPerMillion === null
  )
    throw new Error(`评估需要实际启用并定价的 ${role} 模型。`);
}
const a = await companion('评估伴侣甲');
const b = await companion('评估伴侣乙');
const source = (
  await api('/conversations', 'POST', {
    requestId: randomUUID(),
    title: '固定中文语料',
    kind: 'private',
    includeUser: true,
    companions: [{ companionId: a.id, runtimeEpoch: 1 }],
  })
).conversation.id;
const old = await publish(
  source,
  '我的收货地址是柳城秋树路 12 号。我常去的书店叫蓝湾书屋，朋友都叫它小蓝。',
);
const batch = await api(`/companions/${a.id}/memories/organize`, 'POST', {
  requestId: randomUUID(),
  runtimeEpoch: 1,
  conversationId: source,
});
if (!batch.taskId) throw new Error('已发布的基线语料没有安排整理。');
await finish(batch.taskId);
const changed = await publish(
  source,
  '我搬家了，当前收货地址改为松岚城银杏路 37 号，旧地址已经不用。',
);
await publish(source, '小说里主角的收货地址是虚构港望海路 99 号，和现实里的我无关。', true);
const independent = await api('/chats', 'POST', {
  requestId: randomUUID(),
  companionId: a.id,
  runtimeEpoch: 1,
  title: '甲的独立评估会话',
});
const outside = await api('/chats', 'POST', {
  requestId: randomUUID(),
  companionId: b.id,
  runtimeEpoch: 1,
  title: '乙的独立评估会话',
});
const now = await reply(independent.id, '我现在的收货地址是什么？只回答当前地址。');
const alias = await reply(independent.id, '我常去的小蓝书店，正式名字是什么？');
const bounded = await reply(outside.id, '我在别的伴侣的私聊提到过我的地址，你现在知道是什么吗？');
const after = await api('/models/usage');
const evidence = [
  ...now.pending.map((item) => item.messageId),
  ...now.recall.flatMap((item) => item.evidence.map((source) => source.messageId)),
];
const aliasEvidence = alias.recall.some((item) =>
  item.evidence.some((source) => source.messageId === old.id),
);
const boundary =
  bounded.recall.length === 0 &&
  !bounded.pending.some((item) => [old.id, changed.id].includes(item.messageId));
const checks = {
  currentFact: /银杏路\s*37\s*号/u.test(now.output),
  staleOrFictionalFact: /秋树路\s*12\s*号|望海路\s*99\s*号/u.test(now.output),
  currentEvidence: evidence.includes(changed.id),
  aliasAnswer: /蓝湾书屋/u.test(alias.output),
  aliasEvidenceInRecall: aliasEvidence,
  privateSourceBoundary: boundary,
};
const elapsed = [now.ms, alias.ms, bounded.ms].sort((a, b) => a - b);
const report = {
  configurationVersion: configuration.version,
  models: Object.fromEntries(
    ['chat', 'memory', 'embedding'].map((role) => [role, configuration.config.tasks[role].model]),
  ),
  checks,
  sourceRecallAtK: (Number(checks.currentEvidence) + Number(checks.aliasEvidenceInRecall)) / 2,
  latencyMs: { p50: elapsed[1], p95: elapsed[2] },
  charged: after.global.charged,
  replies: [now.output, alias.output, bounded.output],
};
console.log(JSON.stringify(report, null, 2));
if (
  !checks.currentFact ||
  checks.staleOrFictionalFact ||
  !checks.currentEvidence ||
  !checks.aliasAnswer ||
  !checks.aliasEvidenceInRecall ||
  !checks.privateSourceBoundary
)
  process.exitCode = 1;
