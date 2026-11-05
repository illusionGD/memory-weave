import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createModelClient, ModelClientError, reportModelClientError } from './model-client.mjs';

/** 检查本地配置或读取服务当前状态，不通过 HTTP 发布另一份配置。 */
async function main() {
  const [action = 'check', ...argumentsList] = process.argv.slice(2);
  if (['check', 'show'].includes(action)) {
    if (argumentsList.length > 1) throw new ModelClientError('最多提供一个配置文件路径。');
    const serverRequire = createRequire(new URL('../apps/server/package.json', import.meta.url));
    const child = spawn(
      process.execPath,
      [
        serverRequire.resolve('tsx/cli'),
        '--conditions=memory-weave-source',
        fileURLToPath(
          new URL('../apps/server/src/modules/models/model-config-cli.ts', import.meta.url),
        ),
        action,
        ...argumentsList,
      ],
      { stdio: 'inherit' },
    );
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('error', () => {
      console.error('模型配置命令无法启动，请先安装依赖。');
      process.exitCode = 1;
    });
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }
  if (!['status', 'providers', 'usage'].includes(action) || argumentsList.length)
    throw new ModelClientError(
      '用法：pnpm models:config [check|show] [文件]，或 [status|providers|usage]；修改 JSON 后重启生效，已取消 apply。',
    );
  const api = await createModelClient();
  console.log(
    JSON.stringify(await api(`/models/${action === 'status' ? 'config' : action}`), null, 2),
  );
}
await main().catch(reportModelClientError);
