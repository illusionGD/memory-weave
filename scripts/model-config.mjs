import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  modelConfigurationVersionSchema,
  updateModelConfigurationSchema,
} from '../packages/contracts/dist/index.js';
import { createModelClient, ModelClientError, reportModelClientError } from './model-client.mjs';

/** 导出可编辑命令，保留 expectedVersion 和 requestId；重复发布不产生额外版本。 */
async function main() {
  const [action = 'show', file = 'model-config.local.json'] = process.argv.slice(2);
  if (!['show', 'export', 'apply', 'providers', 'usage'].includes(action))
    throw new ModelClientError(
      '用法：pnpm models:config [show|export|apply|providers|usage] [配置文件]',
    );
  let command;
  if (action === 'apply')
    command = updateModelConfigurationSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const api = await createModelClient();
  if (action === 'providers' || action === 'usage') {
    console.log(JSON.stringify(await api(`/models/${action}`), null, 2));
    return;
  }
  if (command) {
    const saved = modelConfigurationVersionSchema.parse(
      await api('/models/config', { method: 'PUT', body: command }),
    );
    console.log(`模型配置已发布为 v${saved.version}，已有用量保留。`);
    return;
  }
  const current = modelConfigurationVersionSchema.parse(await api('/models/config'));
  if (action === 'show') {
    console.log(JSON.stringify(current, null, 2));
    return;
  }
  await writeFile(
    file,
    `${JSON.stringify({ requestId: randomUUID(), expectedVersion: current.version, config: current.config, evaluationNote: '请填写本次修改与模型评估说明。' }, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    `已导出当前 v${current.version} 配置；编辑后执行 pnpm models:config apply。导出不会覆盖已有文件。`,
  );
}

await main().catch(reportModelClientError);
