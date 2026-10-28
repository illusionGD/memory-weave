import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  taskConfigurationVersionSchema,
  updateTaskConfigurationSchema,
  taskSchema,
  taskListSchema,
  taskOutboxListSchema,
  uuidSchema,
} from '../packages/contracts/dist/index.js';
import { createModelClient, ModelClientError, reportModelClientError } from './model-client.mjs';

/** 配置导出不覆盖文件；控制命令只操作明确指定的单个任务。 */
async function main() {
  const [action = 'show', argument] = process.argv.slice(2);
  if (
    !['show', 'export', 'apply', 'list', 'outbox', 'get', 'pause', 'resume', 'cancel'].includes(
      action,
    )
  )
    throw new ModelClientError(
      '用法：pnpm tasks:config [show|export|apply|list|outbox|get|pause|resume|cancel] [配置文件或任务 ID]',
    );
  const file = argument ?? 'task-config.local.json';
  const command =
    action === 'apply'
      ? updateTaskConfigurationSchema.parse(JSON.parse(await readFile(file, 'utf8')))
      : null;
  const id = ['get', 'pause', 'resume', 'cancel'].includes(action)
    ? uuidSchema.parse(argument)
    : null;
  const api = await createModelClient();
  if (id) {
    const task = taskSchema.parse(
      await api(
        `/tasks/${id}${action === 'get' ? '' : `/${action}`}`,
        action === 'get' ? {} : { method: 'POST', body: {} },
      ),
    );
    console.log(JSON.stringify(task, null, 2));
    return;
  }
  if (action === 'list' || action === 'outbox') {
    const result =
      action === 'list'
        ? taskListSchema.parse(await api('/tasks'))
        : taskOutboxListSchema.parse(await api('/tasks/outbox'));
    console.log(JSON.stringify(result, null, 2));
    if (result.nextAfterId) console.log('这里只显示第一页；通过 HTTP 的 afterId 游标继续查询。');
    return;
  }
  if (command) {
    const saved = taskConfigurationVersionSchema.parse(
      await api('/tasks/config', { method: 'PUT', body: command }),
    );
    console.log(`调度配置已发布为 v${saved.version}，已有尝试和模型额度保持不变。`);
    return;
  }
  const current = taskConfigurationVersionSchema.parse(await api('/tasks/config'));
  if (action === 'show') {
    console.log(JSON.stringify(current, null, 2));
    return;
  }
  await writeFile(
    file,
    `${JSON.stringify({ requestId: randomUUID(), expectedVersion: current.version, config: current.config }, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    `已导出当前 v${current.version}；编辑后执行 pnpm tasks:config apply。已有文件不会覆盖。`,
  );
}
await main().catch(reportModelClientError);
