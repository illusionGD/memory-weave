import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { mysqlConnectionOptions } from './connection';

/** 当前程序所要求的数据库结构状态。 */
export interface SchemaStatus {
  status: 'ready' | 'pending' | 'unavailable';
  version: string | null;
}

/** 迁移命令输出的脱敏结果。 */
export interface MigrationResult extends SchemaStatus {
  status: 'ready';
  applied: number;
}

/** 只允许预先定义的错误信息跨越数据库维护边界。 */
export class MigrationError extends Error {}

interface MigrationEntry {
  tag: string;
  when: number;
  hash: string;
  statements: string[];
}

interface MigrationHistory extends RowDataPacket {
  id: number;
  hash: string;
  created_at: string;
  state: string;
}

const defaultMigrationDirectory = fileURLToPath(new URL('../../drizzle-mysql/', import.meta.url));
// MySQL DDL 隐式提交；applying 状态必须先持久落盘，失败后不能把半完成结构当作就绪。
const HISTORY_TABLE = '__memory_weave_migrations';

/** 校验迁移清单与文件，拒绝缺项、重复、乱序或未登记的 SQL。 */
async function readLocalMigrations(directory: string): Promise<MigrationEntry[]> {
  try {
    const journal: unknown = JSON.parse(
      await readFile(join(directory, 'meta/_journal.json'), 'utf8'),
    );
    if (
      !journal ||
      typeof journal !== 'object' ||
      !('entries' in journal) ||
      !Array.isArray(journal.entries) ||
      !('version' in journal) ||
      journal.version !== '7' ||
      !('dialect' in journal) ||
      journal.dialect !== 'mysql'
    ) {
      throw new Error();
    }
    if (journal.entries.length === 0) throw new Error();
    const entries: MigrationEntry[] = [];
    const tags = new Set<string>();
    let previousTimestamp = 0;
    for (const [index, item] of journal.entries.entries()) {
      const entry = item as Record<string, unknown>;
      if (
        !entry ||
        typeof entry !== 'object' ||
        entry.idx !== index ||
        entry.version !== '5' ||
        typeof entry.tag !== 'string' ||
        !/^\d{4}_[a-zA-Z0-9_-]+$/.test(entry.tag) ||
        tags.has(entry.tag) ||
        typeof entry.when !== 'number' ||
        !Number.isSafeInteger(entry.when) ||
        entry.when <= previousTimestamp ||
        typeof entry.breakpoints !== 'boolean'
      )
        throw new Error();
      const source = await readFile(join(directory, `${entry.tag}.sql`), 'utf8');
      if (!source.trim()) throw new Error();
      tags.add(entry.tag);
      previousTimestamp = entry.when;
      entries.push({
        tag: entry.tag,
        when: entry.when,
        hash: createHash('sha256').update(source).digest('hex'),
        statements: source
          .split('--> statement-breakpoint')
          .map((statement) => statement.trim())
          .filter(Boolean),
      });
    }
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql'));
    if (files.length !== entries.length || files.some((file) => !tags.has(file.slice(0, -4))))
      throw new Error();
    return entries;
  } catch {
    throw new MigrationError('Migration files are invalid.');
  }
}

/** 历史只能是当前发布包的完整前缀；未完成的 DDL 不允许自动跳过或重试。 */
async function readVerifiedHistory(
  client: Pick<Connection, 'query'>,
  local: MigrationEntry[],
): Promise<MigrationHistory[]> {
  const [tables] = await client.query<RowDataPacket[]>(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [HISTORY_TABLE],
  );
  if (tables.length === 0) return [];
  const [rows] = await client.query<MigrationHistory[]>(
    `SELECT id, hash, created_at, state FROM ${HISTORY_TABLE} ORDER BY id`,
  );
  if (rows.length > local.length)
    throw new MigrationError('Migration history does not match this release.');
  for (const [index, row] of rows.entries()) {
    const expected = local[index]!;
    if (
      row.id !== index + 1 ||
      row.hash !== expected.hash ||
      String(row.created_at) !== String(expected.when)
    ) {
      throw new MigrationError('Migration history does not match this release.');
    }
    if (row.state !== 'applied')
      throw new MigrationError(
        'Database migration is incomplete. Restore the database before retrying.',
      );
  }
  return rows;
}

/** 执行当前发布包的 SQL 迁移；数据库连接与语句错误不会泄露到调用方。 */
export async function runMigrations(
  databaseUrl: string,
  migrationDirectory = defaultMigrationDirectory,
): Promise<MigrationResult> {
  const local = await readLocalMigrations(migrationDirectory);
  let client: Connection | undefined;
  let lockName: string | undefined;
  try {
    const options = mysqlConnectionOptions(databaseUrl, 5000);
    client = await createConnection(options);
    await client.query(
      "SET SESSION time_zone = '+00:00', lock_wait_timeout = 10, innodb_lock_wait_timeout = 10",
    );
    const name = `memory-weave:migrate:${createHash('sha256').update(options.database!).digest('hex').slice(0, 32)}`;
    const [locks] = await client.query<RowDataPacket[]>('SELECT GET_LOCK(?, 10) AS acquired', [
      name,
    ]);
    if (locks[0]?.acquired !== 1) throw new MigrationError('Database migration lock timed out.');
    lockName = name;
    const history = await readVerifiedHistory(client, local);
    await client.query(`CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
      id INT PRIMARY KEY, hash CHAR(64) NOT NULL, created_at BIGINT NOT NULL,
      state VARCHAR(16) NOT NULL
    ) ENGINE=InnoDB`);
    for (const [index, entry] of local.entries()) {
      if (index < history.length) continue;
      await client.query(
        `INSERT INTO ${HISTORY_TABLE} (id, hash, created_at, state) VALUES (?, ?, ?, 'applying')`,
        [index + 1, entry.hash, entry.when],
      );
      for (const statement of entry.statements) await client.query(statement);
      await client.query(`UPDATE ${HISTORY_TABLE} SET state = 'applied' WHERE id = ?`, [index + 1]);
    }
    const appliedHistory = await readVerifiedHistory(client, local);
    if (appliedHistory.length !== local.length)
      throw new MigrationError('Migration history does not match this release.');
    return { status: 'ready', version: local.at(-1)!.tag, applied: local.length - history.length };
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError('Database migration failed.');
  } finally {
    if (lockName) await client?.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => undefined);
    await client?.end().catch(() => undefined);
  }
}

/** 查询结构就绪状态，不执行任何数据库写入。 */
export async function getSchemaStatus(
  databaseUrl: string,
  migrationDirectory = defaultMigrationDirectory,
): Promise<SchemaStatus> {
  let client: Connection | undefined;
  try {
    client = await createConnection(mysqlConnectionOptions(databaseUrl));
    return await querySchemaStatus(client, migrationDirectory);
  } catch {
    return { status: 'unavailable', version: null };
  } finally {
    await client?.end().catch(() => undefined);
  }
}

/** 通过既有连接池查询迁移历史，供 HTTP 就绪检查复用，不执行 DDL。 */
export async function querySchemaStatus(
  client: Pick<Connection, 'query'>,
  migrationDirectory = defaultMigrationDirectory,
): Promise<SchemaStatus> {
  try {
    const local = await readLocalMigrations(migrationDirectory);
    const history = await readVerifiedHistory(client, local);
    return {
      status: history.length === local.length ? 'ready' : 'pending',
      version: local[history.length - 1]?.tag ?? null,
    };
  } catch {
    return { status: 'unavailable', version: null };
  }
}
