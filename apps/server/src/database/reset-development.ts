import { createConnection } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { createClient } from 'redis';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerConfig } from '../config';
import { mysqlConnectionOptions } from './connection';
import { runMigrations, MigrationError } from './migrations';

/** 清空当前部署的开发数据并初始化新库，调用前必须停止后端和 worker。 */
export async function resetDevelopment(config: ServerConfig): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new MigrationError('生产模式不能重建开发数据。');
  const options = mysqlConnectionOptions(config.databaseUrl);
  const name = options.database!;
  if (
    !/^[a-zA-Z0-9_]+$/.test(name) ||
    ['mysql', 'sys', 'information_schema', 'performance_schema'].includes(name.toLowerCase())
  )
    throw new MigrationError('开发库名称无效，拒绝重建。');
  const mysql = await createConnection(options);
  const redis = createClient({
    url: config.redisUrl,
    socket: { reconnectStrategy: false, connectTimeout: 1500 },
  });
  redis.on('error', () => undefined);

  /** 只访问已配置的向量服务，不跟随重定向传递认证信息。 */
  async function vector(path: string, method = 'GET') {
    const response = await fetch(`${config.qdrantUrl}${path}`, {
      method,
      headers: { 'api-key': config.qdrantApiKey },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (method === 'DELETE' && response.status === 404) return null;
    if (!response.ok) throw new MigrationError('向量服务不可用，开发数据重建未完成。');
    return response.json() as Promise<unknown>;
  }

  try {
    let owners: string[] = [];
    try {
      const [rows] = await mysql.query<RowDataPacket[]>('SELECT id FROM owners');
      owners = rows.map((row) => String(row.id));
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'ER_NO_SUCH_TABLE'
      )
        throw error;
    }
    if (owners.some((id) => !/^[a-f0-9-]{36}$/i.test(id)))
      throw new MigrationError('用户身份格式异常，拒绝清理文件。');
    const catalog = (await vector('/collections')) as {
      result?: { collections?: { name: string }[] };
    };
    if (!Array.isArray(catalog.result?.collections)) throw new MigrationError('向量集合列表无效。');
    await redis.connect();
    // 先确认所有依赖可用，再开始清理；每一步可重复执行，但跨服务不具有原子性。
    for (const { name: collection } of catalog.result.collections) {
      if (owners.some((id) => collection.startsWith(`mw_${id.replaceAll('-', '')}_`)))
        await vector(`/collections/${encodeURIComponent(collection)}`, 'DELETE');
    }
    for await (const keys of redis.scanIterator({
      MATCH: `${config.redisNamespace}:*`,
      COUNT: 100,
    })) {
      if (keys.length) await redis.unlink(keys);
    }
    for (const ownerId of owners)
      await rm(join(config.dataDir, 'avatars', ownerId), { recursive: true, force: true });
    await mysql.query(`DROP DATABASE \`${name}\``);
    await mysql.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
  } finally {
    if (redis.isOpen) redis.destroy();
    await mysql.end();
  }
  await runMigrations(config.databaseUrl);
}
