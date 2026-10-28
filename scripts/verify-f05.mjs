import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  companionPersonaStateSchema,
  personaTemplateSchema,
  personaVersionSchema,
  modelConfigurationVersionSchema,
  taskConfigurationVersionSchema,
  modelUsageSchema,
} from '../packages/contracts/dist/index.js';
import { createModelClient, ModelClientError, reportModelClientError } from './model-client.mjs';

let passed = 0;
/** 验收仅通过公开 HTTP，不输出原稿、凭据或连接配置。 */
function check(condition, message) {
  if (!condition) throw new ModelClientError(message);
  passed++;
  console.log(`[通过 ${String(passed).padStart(2, '0')}] ${message}`);
}

/** 原任务有界等待，未知结果不换键重发。 */
async function ready(api, state) {
  for (let i = 0; i < 120; i++) {
    const current = companionPersonaStateSchema.parse(
      await api(`/companions/${state.companion.id}/persona`),
    );
    if (current.task?.status === 'succeeded') return current;
    if (current.task && ['failed', 'blocked', 'cancelled', 'paused'].includes(current.task.status))
      throw new ModelClientError(
        `任务 ${current.task.id} 未完成：${current.task.reason ?? current.task.status}。`,
      );
    await delay(500);
  }
  throw new ModelClientError(`任务 ${state.task?.id} 尚未完成，请在伴侣详情查看进度。`);
}

/** 保存三位隔离验收伴侣和一个模板，不删除已有数据或改变模型供应商。 */
async function main() {
  const api = await createModelClient();
  const configuration = modelConfigurationVersionSchema.parse(await api('/models/config'));
  if (configuration.config.tasks.persona.providerId !== 'test')
    throw new ModelClientError('本脚本只允许 persona 使用 test，不会替你切换配置或发起付费调用。');
  const scheduler = taskConfigurationVersionSchema.parse(await api('/tasks/config'));
  if (!scheduler.config.enabled)
    throw new ModelClientError('调度已停用，请按实际需求启用后再验收。');
  const before = modelUsageSchema.parse(await api('/models/usage'));
  const command = {
    requestId: randomUUID(),
    name: 'F05 验收 · 原稿',
    source: {
      kind: 'text',
      profileText: '小夜是旅行记录者，喜欢文学，起初慢热。',
      lockedFeatures: ['保持独立思考'],
    },
  };
  const pending = companionPersonaStateSchema.parse(
    await api('/companion-creations', { method: 'POST', body: command }),
  );
  check(
    pending.companion.initialSnapshot.profileText === command.source.profileText,
    '创建时完整保存原稿',
  );
  const replay = companionPersonaStateSchema.parse(
    await api('/companion-creations', { method: 'POST', body: command }),
  );
  check(
    replay.companion.id === pending.companion.id && replay.task?.id === pending.task?.id,
    '同一创建命令复用实例和持久任务',
  );
  let conflict = false;
  try {
    await api('/companion-creations', { method: 'POST', body: { ...command, name: '异载荷' } });
  } catch (error) {
    if (error instanceof ModelClientError && error.code === 40901) conflict = true;
    else throw error;
  }
  check(conflict, '同键不同内容被拒绝');
  const first = await ready(api, pending);
  check(
    first.companion.currentPersonaVersion.mode === 'test' &&
      first.companion.currentPersonaVersion.version === 2,
    '后台完成整理并明确记录测试模式',
  );
  check(
    isDeepStrictEqual(first.initialPersonaVersion, first.companion.currentPersonaVersion),
    '首个整理版本成为独立初始基线',
  );
  const template = personaTemplateSchema.parse(
    await api('/persona-templates', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: 'F05 验收模板',
        initialProfile: '小雨喜欢文学。',
        lockedFeatures: [],
      },
    }),
  );
  const templated = await ready(
    api,
    companionPersonaStateSchema.parse(
      await api('/companion-creations', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          name: 'F05 验收 · 模板旧版',
          source: { kind: 'template', template: { id: template.id, version: 1 } },
        },
      }),
    ),
  );
  const secondTemplate = personaTemplateSchema.parse(
    await api(`/persona-templates/${template.id}/versions`, {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        expectedVersion: 1,
        name: template.name,
        initialProfile: '小雨喜欢旅行。',
        lockedFeatures: [],
      },
    }),
  );
  check(secondTemplate.version === 2, '模板更新追加新版本');
  check(
    isDeepStrictEqual(await api(`/persona-templates/${template.id}/versions/1`), template),
    '模板首版仍可精确查询',
  );
  check(
    isDeepStrictEqual(await api(`/companions/${templated.companion.id}/persona`), templated),
    '模板更新不覆盖已有伴侣',
  );
  const latest = await ready(
    api,
    companionPersonaStateSchema.parse(
      await api('/companion-creations', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          name: 'F05 验收 · 模板新版',
          source: { kind: 'template', template: { id: template.id, version: 2 } },
        },
      }),
    ),
  );
  check(
    latest.companion.initialSnapshot.profileText === secondTemplate.initialProfile &&
      latest.companion.id !== templated.companion.id,
    '选用新版产生独立实例及初始快照',
  );
  const revision = personaVersionSchema.parse(
    await api(`/companions/${first.companion.id}/persona/locks`, {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        runtimeEpoch: 1,
        expectedPersonaVersion: 2,
        lockedFeatures: ['保持独立思考', '始终真诚'],
      },
    }),
  );
  check(revision.version === 3 && revision.origin === 'lock_revision', '约束修订追加人格版本');
  const revised = companionPersonaStateSchema.parse(
    await api(`/companions/${first.companion.id}/persona`),
  );
  check(
    isDeepStrictEqual(revised.initialPersonaVersion, first.initialPersonaVersion) &&
      isDeepStrictEqual(revised.companion.initialSnapshot, pending.companion.initialSnapshot),
    '当前修订不覆盖初始人格或原稿',
  );
  const originalVersion = personaVersionSchema.parse(
    await api(`/companions/${first.companion.id}/persona/versions/1?runtimeEpoch=1`),
  );
  check(
    originalVersion.profileText === command.source.profileText && originalVersion.document === null,
    '原稿人格版本仍可按实例和代次回查',
  );
  check(
    isDeepStrictEqual(await api(`/companions/${templated.companion.id}/persona`), templated),
    '另一伴侣不受约束修订影响',
  );
  const after = modelUsageSchema.parse(await api('/models/usage'));
  check(
    after.global.charged.requests - before.global.charged.requests === 3,
    '仅三次初始整理计入模型调用，模板编辑和约束修订不调用模型',
  );
  console.log(
    `验收完成：${passed} 项。保留伴侣 ${first.companion.id}、${templated.companion.id}、${latest.companion.id} 供页面检查。`,
  );
}

main().catch(reportModelClientError);
