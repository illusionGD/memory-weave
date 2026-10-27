import type { ConnectionOptions } from 'mysql2/promise';

/**
 * 将连接串转换为固定安全选项；统一 UTC，禁止多语句及 URL 覆盖驱动行为。
 * @param databaseUrl 私有 MySQL 连接串，调用方负责脱敏错误。
 * @param connectTimeout 建立连接的超时时间，单位毫秒。
 * @returns 业务连接池和独立维护连接共用的配置。
 */
export function mysqlConnectionOptions(
  databaseUrl: string,
  connectTimeout = 1000,
): ConnectionOptions {
  const url = new URL(databaseUrl);
  if (
    url.protocol !== 'mysql:' ||
    !url.hostname ||
    url.pathname.length < 2 ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid MySQL connection URL.');
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    charset: 'utf8mb4',
    timezone: 'Z',
    connectTimeout,
    multipleStatements: false,
    enableKeepAlive: true,
  };
}
