import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const url = new URL(process.env.F24_BASE_URL ?? 'http://127.0.0.1:3000');
const password = process.env.F24_ADMIN_PASSWORD;
const rounds = Number(process.env.F24_ROUNDS ?? 160);
const concurrency = Number(process.env.F24_CONCURRENCY ?? 4);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !password)
  throw new Error('请使用隔离部署的本地端口和 F24_ADMIN_PASSWORD。');
if (
  !Number.isInteger(rounds) ||
  rounds < 1 ||
  rounds > 2000 ||
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 8
)
  throw new Error('压测需要 1～2000 轮和 1～8 个并发会话。');
let cookie = '';

/** 发送已认证的业务请求，错误只报告状态和路径。 */
async function request(path, method = 'GET', body) {
  const response = await fetch(new URL(`/api${path}`, url), {
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

/** 等待测试任务确认实际完成。 */
async function waitTask(id) {
  for (let i = 0; i < 240; i++) {
    const task = await request(`/tasks/${id}`);
    if (task.status === 'succeeded') return;
    if (['failed', 'blocked', 'cancelled'].includes(task.status))
      throw new Error(`测试任务结束于 ${task.status} (${task.reason})。`);
    await delay(125);
  }
  throw new Error('等待测试任务超时。');
}

/** 从实际 SSE 观察模型正式发表的第一条回复。 */
async function firstOutput(room, sequence) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const path = `/api/chats/${room}/events?afterSequence=${sequence}`;
    const response = await fetch(new URL(path, url), {
      headers: { cookie },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`事件流 HTTP ${response.status}。`);
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop();
      for (const frame of frames) {
        if (!frame.includes('event: message')) continue;
        const payload = frame.split('\n').find((line) => line.startsWith('data: '));
        if (!payload) continue;
        const item = JSON.parse(payload.slice(6)).data;
        if (item?.message?.sourceKind === 'model_output') return;
      }
    }
    throw new Error('事件流结束前没有正式回复。');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** 统计请求分位数，包括并发后端领取与读取等待。 */
function metrics(samples) {
  const values = [...samples].sort((a, b) => a - b);
  const value = (p) => Number(values[Math.ceil(p * values.length) - 1].toFixed(1));
  return { p50: value(0.5), p95: value(0.95), max: value(1) };
}

await request('/auth/login', 'POST', { password });
const models = await request('/models/config');
if (Object.values(models.config.tasks).some((task) => task.enabled && task.providerId !== 'test'))
  throw new Error('容量测试仅使用确定性测试配置。');
const companions = await request('/companions?limit=1');
if (companions.items.length) throw new Error('请为每次容量测试准备全新的隔离部署。');
const registry = await request('/management/configuration');
if (registry.groups.find((group) => group.name === 'models')?.update === 'api') {
  models.config.dailyBudget.requests = 20000;
  models.config.dailyBudget.tokens = 50_000_000;
  for (const task of Object.values(models.config.tasks))
    task.dailyBudget = { ...models.config.dailyBudget };
  await request('/models/config', 'PUT', {
    requestId: randomUUID(),
    expectedVersion: models.version,
    config: models.config,
    evaluationNote: '隔离容量测量使用确定性配置。',
  });
} else if (models.config.tasks.chat.dailyBudget.requests < rounds) {
  throw new Error('请提高隔离测试模型文件的聊天请求额度以覆盖本次轮数。');
}
const taskConfig = await request('/tasks/config');
await request('/tasks/config', 'PUT', {
  requestId: randomUUID(),
  expectedVersion: taskConfig.version,
  config: { ...taskConfig.config, pollMs: 250 },
});

const acknowledgement = [],
  first = [],
  completed = [];
let started = 0;
const start = performance.now();
await Promise.all(
  Array.from({ length: concurrency }, async (_, worker) => {
    const companion = await request('/companions', 'POST', {
      requestId: randomUUID(),
      name: `容量伴侣 ${worker + 1}`,
      initialProfile: '测试伴侣负责整理固定合成语料。',
    });
    const room = await request('/chats', 'POST', {
      requestId: randomUUID(),
      companionId: companion.id,
      runtimeEpoch: 1,
      title: `容量会话 ${worker + 1}`,
    });
    while (started < rounds) {
      const index = ++started;
      const timestamp = performance.now();
      const result = await request(`/chats/${room.id}/messages`, 'POST', {
        requestId: randomUUID(),
        text: `隔离压测第 ${index} 条。蓝色笔记记录城东书店的读书会，周六下午三点见面。`,
      });
      acknowledgement.push(performance.now() - timestamp);
      await firstOutput(room.id, result.message.sequence);
      first.push(performance.now() - timestamp);
      await waitTask(result.run.id);
      completed.push(performance.now() - timestamp);
    }
  }),
);
const wallSeconds = (performance.now() - start) / 1000;
const usage = await request('/models/usage');
console.log(
  JSON.stringify(
    {
      fixture: 'deterministic',
      rounds,
      concurrency,
      seconds: Number(wallSeconds.toFixed(1)),
      roundsPerSecond: Number((rounds / wallSeconds).toFixed(2)),
      acknowledgementsMs: metrics(acknowledgement),
      firstPublishedMs: metrics(first),
      completedMs: metrics(completed),
      modelUsage: usage.global.charged,
    },
    null,
    2,
  ),
);
