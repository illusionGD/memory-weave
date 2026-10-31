import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from './database';

// 显式测试连接只用于创建随机隔离库；所有非空记忆经 HTTP 和本地模型 fixture 生成。
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const database = await createTestDatabase();
try {
  const child = spawn(
    process.execPath,
    [
      require.resolve('@playwright/test/cli'),
      'test',
      'memory-explorer.spec.ts',
      ...process.argv.slice(2),
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, TEST_DATABASE_URL: database.databaseUrl },
    },
  );
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
} finally {
  await database.dispose();
}
