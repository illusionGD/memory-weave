/**
 * 将 Compose 的 MySQL 配置转换为服务使用的 DATABASE_URL。
 * 凭据只编码一次，保留密码中的 URI 特殊字符。
 */
function configureDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return;
  }

  const requiredKeys = [
    'MYSQL_HOST',
    'MYSQL_PORT',
    'MYSQL_DATABASE',
    'MYSQL_USER',
    'MYSQL_PASSWORD',
  ];

  for (const key of requiredKeys) {
    if (!process.env[key]) {
      throw new Error(`Missing required database configuration: ${key}`);
    }
  }

  const databaseUrl = new URL('mysql://localhost');
  databaseUrl.hostname = process.env.MYSQL_HOST;
  databaseUrl.port = process.env.MYSQL_PORT;
  databaseUrl.pathname = `/${encodeURIComponent(process.env.MYSQL_DATABASE)}`;
  databaseUrl.username = encodeURIComponent(process.env.MYSQL_USER);
  databaseUrl.password = encodeURIComponent(process.env.MYSQL_PASSWORD);
  process.env.DATABASE_URL = databaseUrl.toString();
}

/** 将容器 Redis 配置转换为连接串，只编码一次访问密码。 */
function configureRedisUrl() {
  if (process.env.REDIS_URL) return;
  for (const key of ['REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD']) {
    if (!process.env[key]) throw new Error(`Missing required Redis configuration: ${key}`);
  }
  const redisUrl = new URL('redis://localhost/0');
  redisUrl.hostname = process.env.REDIS_HOST;
  redisUrl.port = process.env.REDIS_PORT;
  redisUrl.password = encodeURIComponent(process.env.REDIS_PASSWORD);
  process.env.REDIS_URL = redisUrl.toString();
}

configureDatabaseUrl();
const command = process.argv[2];
if (command === 'migrate' || command === 'status') {
  await import('../dist/database/migrate-cli.js');
} else if (command === undefined) {
  configureRedisUrl();
  await import('../dist/main.js');
} else {
  console.error('不支持的容器启动命令。');
  process.exitCode = 1;
}
