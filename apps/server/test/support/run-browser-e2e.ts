import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from './database';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const database = await createTestDatabase();
try {
  const memories = await createTestDatabase();
  try {
    const child = spawn(
      process.execPath,
      [require.resolve('@playwright/test/cli'), 'test', ...process.argv.slice(2)],
      {
        cwd: root,
        stdio: 'inherit',
        env: {
          ...process.env,
          TEST_DATABASE_URL: database.databaseUrl,
          TEST_MEMORY_EXPLORER_DATABASE_URL: memories.databaseUrl,
        },
      },
    );
    /** 停止本次浏览器运行，并由 finally 清理两个隔离库。 */
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
    await memories.dispose();
  }
} finally {
  await database.dispose();
}
