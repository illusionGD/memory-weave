import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  modelCallSchema,
  modelConfigurationVersionSchema,
  modelProviderCatalogSchema,
  modelUsageSchema,
  modelDiagnosticValueSchema,
} from '../packages/contracts/dist/index.js';
import { createModelClient, ModelClientError, reportModelClientError } from './model-client.mjs';

let passed = 0;
/** 用固定期望验收公开行为，不输出原文输入、密钥或 Cookie。 */
function check(condition, message) {
  if (!condition) throw new ModelClientError(message);
  passed += 1;
  console.log(`[通过 ${String(passed).padStart(2, '0')}] ${message}`);
}

/** 默认只调用确定性 adapter；不会替用户改配置或调用付费服务。 */
async function main() {
  const api = await createModelClient();
  const catalog = modelProviderCatalogSchema.parse(await api('/models/providers'));
  check(
    catalog.providers.some((provider) => provider.id === 'test' && provider.kind === 'test'),
    '测试模型与真实供应商明确区分',
  );
  const current = modelConfigurationVersionSchema.parse(await api('/models/config'));
  if (
    current.config.tasks.chat.providerId !== 'test' ||
    current.config.tasks.embedding.providerId !== 'test'
  )
    throw new ModelClientError(
      '此脚本只验收 test 模型；请在隔离测试部署运行，不会自动更换当前模型。',
    );
  check(
    isDeepStrictEqual(
      current,
      modelConfigurationVersionSchema.parse(
        await api(`/models/config/versions/${current.version}`),
      ),
    ),
    '有效配置可按不可变版本回查',
  );
  const before = modelUsageSchema.parse(await api('/models/usage'));
  const commands = [
    {
      requestId: randomUUID(),
      expectedConfigVersion: current.version,
      role: 'chat',
      operation: 'text',
      inputText: 'F03 文本验收',
    },
    {
      requestId: randomUUID(),
      expectedConfigVersion: current.version,
      role: 'chat',
      operation: 'structured',
      inputText: 'F03 结构验收',
    },
    {
      requestId: randomUUID(),
      expectedConfigVersion: current.version,
      role: 'embedding',
      operation: 'embedding',
      inputText: 'F03 向量验收',
    },
  ];
  const calls = [];
  for (const command of commands) {
    const call = modelCallSchema.parse(
      await api('/models/probes', { method: 'POST', body: command }),
    );
    check(
      call.status === 'succeeded' && call.attempts.length === 1,
      `${command.operation} 调用完成且仅发送一次`,
    );
    calls.push(call);
  }
  check(
    calls[0].result?.kind === 'text' && calls[0].result.text === '测试模型已收到：F03 文本验收',
    '文本结果符合固定测试期望',
  );
  check(
    calls[1].result?.kind === 'structured' &&
      modelDiagnosticValueSchema.safeParse(calls[1].result.value).success,
    '结构化结果符合公共诊断规范',
  );
  check(
    calls[2].result?.kind === 'embedding' &&
      calls[2].result.vector.length === current.config.tasks.embedding.dimensions,
    '向量维度与独立编码配置一致',
  );
  const replay = await api('/models/probes', { method: 'POST', body: commands[0] });
  check(isDeepStrictEqual(replay, calls[0]), '同键重放返回原调用与原结果');
  let conflict;
  try {
    await api('/models/probes', {
      method: 'POST',
      body: { ...commands[0], inputText: '不同内容' },
    });
  } catch (error) {
    conflict = error;
  }
  check(conflict instanceof ModelClientError && conflict.code === 40901, '同键不同内容被拒绝');
  check(
    isDeepStrictEqual(await api(`/models/calls/${calls[0].id}`), calls[0]),
    '调用详情与每次实际尝试可回查',
  );
  const after = modelUsageSchema.parse(await api('/models/usage'));
  check(
    before.day === after.day &&
      after.global.charged.requests - before.global.charged.requests === 3 &&
      after.global.charged.tokens - before.global.charged.tokens === 52,
    '全局用量仅增加三次请求和 52 个测试 token',
  );
  check(
    after.tasks.chat.charged.requests - before.tasks.chat.charged.requests === 2 &&
      after.tasks.embedding.charged.requests - before.tasks.embedding.charged.requests === 1,
    '聊天与向量任务分别计量',
  );
  console.log(`F03 共 ${passed} 项通过。已持久保存 3 条测试调用，不写伴侣、消息或向量索引。`);
  console.log(`文本调用 ID：${calls[0].id}`);
}

await main().catch(reportModelClientError);
