import { createHash } from 'node:crypto';
import { createConnection } from 'mysql2';
import type { RowDataPacket } from 'mysql2/promise';
import { mysqlConnectionOptions } from './connection';

/** 主服务和维护工具共享同一数据库闸门，备份与恢复需要独占离线访问。 */
export async function acquireArchiveLock(databaseUrl: string) {
  const options = mysqlConnectionOptions(databaseUrl, 5000);
  const connection = createConnection({
    ...options,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  const client = connection.promise();
  const name = `memory-weave:data:${createHash('sha256').update(options.database!).digest('hex').slice(0, 32)}`;
  try {
    const [rows] = await client.query<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS acquired', [name]);
    if (Number(rows[0]?.acquired) !== 1) throw new Error('数据库正被服务或其他维护命令使用。');
    return {
      client,
      connection,
      /** 关闭专用连接，释放当前数据库的离线闸门。 */
      async close() {
        try {
          await client.query('SELECT RELEASE_LOCK(?)', [name]);
        } finally {
          await client.end();
        }
      },
    };
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}
