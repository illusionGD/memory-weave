import { acquireArchiveLock } from './archive-lock';
import { getSchemaStatus, MigrationError, runMigrations } from './migrations';
import { loadServerConfig } from '../config';
import { resetDevelopment } from './reset-development';

/**
 * 执行数据库迁移或状态查询命令。
 *
 * 维护命令只读取数据库连接配置，不要求 HTTP 登录或静态资源配置。
 */
async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const command = argumentsList[0] ?? 'migrate';
  const remaining = argumentsList.slice(1);
  if (command === 'reset' && remaining.length === 0) {
    const config = loadServerConfig(process.env, { loadModels: false });
    await offline(config.databaseUrl, () => resetDevelopment(config));
    console.info(JSON.stringify({ status: 'ready', reset: true }));
    return;
  }
  if (
    !['migrate', 'status'].includes(command) ||
    (remaining.length !== 0 && (remaining.length !== 2 || remaining[0] !== '--migrations-dir'))
  )
    throw new MigrationError('Invalid migration command.');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new MigrationError('DATABASE_URL is required.');
  const result =
    command === 'status'
      ? await getSchemaStatus(databaseUrl, remaining[1])
      : await offline(databaseUrl, () => runMigrations(databaseUrl, remaining[1]));
  console.info(JSON.stringify(result));
  if (result.status !== 'ready') process.exitCode = 1;
}

/** 更新结构与离线归档互斥，先停止正在使用目标数据库的服务。 */
async function offline<T>(databaseUrl: string, maintain: () => Promise<T>): Promise<T> {
  const lock = await acquireArchiveLock(databaseUrl).catch(() => {
    throw new MigrationError('Database migration needs exclusive access to the deployment.');
  });
  try {
    return await maintain();
  } finally {
    await lock.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof MigrationError ? error.message : 'Database migration failed.');
  process.exitCode = 1;
});
