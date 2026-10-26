import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

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
}

interface MigrationHistory {
  id: number;
  hash: string;
  created_at: string;
}

const defaultMigrationDirectory = fileURLToPath(new URL('../../drizzle/', import.meta.url));
// 所有发布版本共用固定的会话锁，连接关闭时 PostgreSQL 会自动释放。
const migrationLock = [1_297_559_383, 1_179_276_882] as const;

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
      journal.dialect !== 'postgresql'
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
        entry.version !== '7' ||
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

/** 历史只能是当前发布包的完整前缀，不能跳过、改写或超过本地版本。 */
async function readVerifiedHistory(
  client: Pick<Pool, 'query'>,
  local: MigrationEntry[],
): Promise<MigrationHistory[]> {
  const relation = await client.query<{ present: string | null }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') AS present",
  );
  if (!relation.rows[0]?.present) return [];
  const result = await client.query<MigrationHistory>(
    'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id',
  );
  if (result.rows.length > local.length)
    throw new MigrationError('Migration history does not match this release.');
  let previousId = 0;
  for (const [index, row] of result.rows.entries()) {
    const expected = local[index]!;
    if (
      !Number.isInteger(row.id) ||
      row.id <= previousId ||
      row.hash !== expected.hash ||
      String(row.created_at) !== String(expected.when)
    ) {
      throw new MigrationError('Migration history does not match this release.');
    }
    previousId = row.id;
  }
  return result.rows;
}

/** 执行当前发布包的 SQL 迁移；数据库连接与语句错误不会泄露到调用方。 */
export async function runMigrations(
  databaseUrl: string,
  migrationDirectory = defaultMigrationDirectory,
): Promise<MigrationResult> {
  const local = await readLocalMigrations(migrationDirectory);
  let client: Client | undefined;
  let locked = false;
  try {
    client = new Client({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5000,
      statement_timeout: 60_000,
      lock_timeout: 10_000,
      idle_in_transaction_session_timeout: 60_000,
    });
    client.on('error', () => undefined);
    await client.connect();
    // 在读取历史前加锁，避免两个部署同时判断同一迁移尚未执行。
    await client.query('SELECT pg_advisory_lock($1, $2)', [...migrationLock]);
    locked = true;
    const history = await readVerifiedHistory(client, local);
    await migrate(drizzle(client), { migrationsFolder: migrationDirectory });
    const appliedHistory = await readVerifiedHistory(client, local);
    if (appliedHistory.length !== local.length) {
      throw new MigrationError('Migration history does not match this release.');
    }
    return {
      status: 'ready',
      version: local.at(-1)!.tag,
      applied: local.length - history.length,
    };
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError('Database migration failed.');
  } finally {
    if (locked) {
      await client
        ?.query('SELECT pg_advisory_unlock($1, $2)', [...migrationLock])
        .catch(() => undefined);
    }
    await client?.end().catch(() => undefined);
  }
}

/** 查询结构就绪状态，不执行任何数据库写入。 */
export async function getSchemaStatus(
  databaseUrl: string,
  migrationDirectory = defaultMigrationDirectory,
): Promise<SchemaStatus> {
  let client: Client | undefined;
  try {
    client = new Client({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 1000,
      statement_timeout: 1000,
    });
    client.on('error', () => undefined);
    await client.connect();
    return await querySchemaStatus(client, migrationDirectory);
  } catch {
    return { status: 'unavailable', version: null };
  } finally {
    await client?.end().catch(() => undefined);
  }
}

/** 通过既有连接池查询迁移历史，供 HTTP 就绪检查复用，不执行 DDL。 */
export async function querySchemaStatus(
  client: Pick<Pool, 'query'>,
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
