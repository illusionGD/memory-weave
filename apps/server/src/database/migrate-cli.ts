import { getSchemaStatus, MigrationError, runMigrations } from './migrations';

/** 维护命令只读取数据库连接配置，不要求 HTTP 登录或静态资源配置。 */
async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const command = argumentsList[0] ?? 'migrate';
  const remaining = argumentsList.slice(1);
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
      : await runMigrations(databaseUrl, remaining[1]);
  console.info(JSON.stringify(result));
  if (result.status !== 'ready') process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof MigrationError ? error.message : 'Database migration failed.');
  process.exitCode = 1;
});
