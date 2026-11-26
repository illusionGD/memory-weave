import { createHash } from 'node:crypto';
import { createConnection } from 'mysql2';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { mysqlConnectionOptions } from './connection';

const runtimeSlots = 32;

/** 已有运行服务或维护请求时的明确占用状态。 */
export class StorageBusyError extends Error {}

/** 主服务可共享运行许可，维护任务需要独占而且等待所有运行连接退出。 */
export function acquireRuntimeStorageLock(databaseUrl: string) {
  return acquireStorageLock(databaseUrl, 'runtime', 5);
}

/** 获取部署离线维护许可。 */
export function acquireArchiveLock(databaseUrl: string, waitSeconds = 0) {
  return acquireStorageLock(databaseUrl, 'offline', waitSeconds);
}

/** 调度闸门保护短许可登记及长期离线维护。 */
async function acquireStorageLock(
  databaseUrl: string,
  mode: 'runtime' | 'offline',
  waitSeconds: number,
) {
  const options = mysqlConnectionOptions(databaseUrl, 5000);
  const connection = createConnection({
    ...options,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  const client = connection.promise();
  const prefix = `memory-weave:data:${createHash('sha256').update(options.database!).digest('hex').slice(0, 32)}`;
  const gate = prefix;
  const slots = Array.from({ length: runtimeSlots }, (_, i) => `${prefix}:run:${i}`);
  try {
    if (!(await take(client, gate, waitSeconds)))
      throw new StorageBusyError('数据库正被服务或其他维护命令使用。');
    let held = gate;
    if (mode === 'runtime') {
      const slot = await takeRuntimeSlot(client, slots);
      if (!slot) throw new Error('数据库运行连接已达到上限。');
      held = slot;
      await client.query('SELECT RELEASE_LOCK(?)', [gate]);
    } else {
      const checks = slots.map((_, index) => `IS_FREE_LOCK(?) AS slot_${index}`).join(', ');
      const [rows] = await client.query<RowDataPacket[]>(`SELECT ${checks}`, slots);
      if (!rows[0] || !Object.values(rows[0]).every((value) => Number(value) === 1))
        throw new StorageBusyError('数据库正被服务或其他维护命令使用。');
    }
    return {
      client,
      connection,
      /** 关闭专用连接并确认许可已释放。 */
      async close() {
        try {
          await client.query('SELECT RELEASE_LOCK(?)', [held]);
        } finally {
          await client.end();
        }
      },
    };
  } catch (error) {
    await client.query('SELECT RELEASE_ALL_LOCKS()').catch(() => undefined);
    await client.end().catch(() => undefined);
    throw error;
  }
}

/** 获取首个空闲运行槽位，离线检查使用同一组身份。 */
async function takeRuntimeSlot(client: Connection, slots: string[]) {
  for (const slot of slots) if (await take(client, slot, 0)) return slot;
  return null;
}

/** 对齐驱动可能用字符串返回锁结果。 */
async function take(client: Connection, name: string, timeout: number) {
  const [rows] = await client.query<RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS acquired', [
    name,
    timeout,
  ]);
  return Number(rows[0]?.acquired) === 1;
}
