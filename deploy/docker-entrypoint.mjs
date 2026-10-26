/**
 * Convert Compose's discrete database settings into the server's DATABASE_URL.
 * Encoding each credential once preserves passwords containing URI delimiters.
 */
function configureDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return;
  }

  const requiredKeys = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'];

  for (const key of requiredKeys) {
    if (!process.env[key]) {
      throw new Error(`Missing required database configuration: ${key}`);
    }
  }

  const databaseUrl = new URL('postgresql://localhost');
  databaseUrl.hostname = process.env.PGHOST;
  databaseUrl.port = process.env.PGPORT;
  databaseUrl.pathname = `/${encodeURIComponent(process.env.PGDATABASE)}`;
  databaseUrl.username = encodeURIComponent(process.env.PGUSER);
  databaseUrl.password = encodeURIComponent(process.env.PGPASSWORD);
  process.env.DATABASE_URL = databaseUrl.toString();
}

configureDatabaseUrl();
const command = process.argv[2];
if (command === 'migrate' || command === 'status') {
  await import('../dist/database/migrate-cli.js');
} else if (command === undefined) {
  await import('../dist/main.js');
} else {
  console.error('不支持的容器启动命令。');
  process.exitCode = 1;
}
