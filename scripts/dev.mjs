import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = process.argv[2];
if (target && !['web', 'admin'].includes(target)) throw new Error('开发目标只能是 web 或 admin。');
const clients = target ? [target] : ['web', 'admin'];
const adminOrigin = new URL(process.env.APP_ORIGIN || 'http://localhost:5173');
adminOrigin.port = '5174';
const child = spawn(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  [
    '--parallel',
    '--filter',
    '@memory-weave/server',
    ...clients.flatMap((name) => ['--filter', `@memory-weave/${name}`]),
    'dev',
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      DATA_DIR: resolve(root, process.env.DATA_DIR || 'data'),
      ADMIN_APP_ORIGIN: process.env.ADMIN_APP_ORIGIN || adminOrigin.origin,
    },
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
  },
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (process.platform === 'win32') {
      child.kill(signal);
      return;
    }

    // pnpm launches shells and watchers; stop the isolated process group, not just its parent.
    if (child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
          throw error;
        }
      }
    }
  });
}

child.on('error', (error) => {
  console.error('开发进程启动失败：', error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 0 : 1);
});
