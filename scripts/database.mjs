import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const serverRequire = createRequire(new URL('../apps/server/package.json', import.meta.url));
const entry = fileURLToPath(new URL('../apps/server/src/database/migrate-cli.ts', import.meta.url));
// 使用 Node 直接运行公开的 tsx CLI，Windows 上无需经过 shell 拼接参数。
const child = spawn(
  process.execPath,
  [serverRequire.resolve('tsx/cli'), entry, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
  },
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', () => {
  console.error('数据库维护命令无法启动，请先安装项目依赖。');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
