import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const child = spawn(process.execPath, [resolve(root, 'apps/server/dist/main.js')], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    DATA_DIR: resolve(root, process.env.DATA_DIR || 'data'),
    WEB_DIST_DIR: resolve(root, process.env.WEB_DIST_DIR || 'apps/web/dist'),
  },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', (error) => {
  console.error('应用启动失败：', error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 0 : 1);
});
