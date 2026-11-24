import { createHash } from 'node:crypto';
import { createConnection } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { mysqlConnectionOptions } from '../../database/connection';

/** 同一 MySQL 部署仅允许一个解析线程，连接中断自动释放容量。 */
export async function withMaterialCapacity<T>(
  databaseUrl: string,
  operation: () => Promise<T>,
): Promise<T | undefined> {
  const options = mysqlConnectionOptions(databaseUrl);
  const name = `memory-weave:materials:${createHash('sha256').update(options.database!).digest('hex').slice(0, 32)}`;
  const connection = await createConnection(options);
  try {
    const [rows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS acquired', [
      name,
    ]);
    if (rows[0]?.acquired !== 1) return undefined;
    return await operation();
  } finally {
    await connection.end();
  }
}
