import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { getTableName } from 'drizzle-orm';
import * as schema from './schema';
import type { ServerConfig } from '../config';
import {
  digestBytes,
  journalPath,
  readLifecycleJournal,
  verifyJournalPrefix,
} from '../modules/lifecycle/lifecycle-journal';
import { acquireArchiveLock } from './archive-lock';
import {
  archiveManifestSchema,
  assertFileDigest,
  assertSeparate,
  copyAsset,
  identifier,
} from './archive-format';
import type { ArchiveAsset, ArchiveManifest } from './archive-format';
import { querySchemaStatus } from './migrations';

const rowSchema = z.record(z.string(), z.json());
const restoreMarker = '.restore-in-progress';
const restoreManifest = 'restore-result.json';
const archiveTables = 'tables';
const archiveFiles = 'files';

/** 读取一个已迁移且离线的部署，保存带校验的 JSONL 数据和确切附件引用。 */
export async function exportArchive(
  config: ServerConfig,
  directory: string,
): Promise<ArchiveManifest> {
  const root = resolve(directory);
  const journalDirectory = requireJournal(config, root);
  const lock = await acquireArchiveLock(config.databaseUrl);
  let created = false;
  try {
    const { client, connection } = lock;
    const version = await readyVersion(client);
    await mkdir(root, { mode: 0o700 });
    created = true;
    await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
    const independentLog = await open(journalPath(journalDirectory), 'a', 0o600);
    await independentLog.close();
    const journal = await readLifecycleJournal(journalDirectory);
    await mkdir(join(root, archiveTables), { mode: 0o700 });
    await client.query("SET SESSION time_zone = '+00:00'");
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await client.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const ownerId = await onlyOwner(client);
    if (journal.records.some((row) => row.ownerId !== ownerId))
      throw new Error('独立生命周期日志所属部署不匹配。');
    const tables: ArchiveManifest['tables'] = [];
    for (const name of await tableNames(client)) {
      const file = await open(tablePath(root, name), 'wx', 0o600);
      const hash = createHash('sha256');
      let rows = 0,
        bytes = 0;
      try {
        const stream = connection
          .query(`SELECT * FROM ${identifier(name)}`)
          .stream({ highWaterMark: 8 });
        for await (const row of stream) {
          const value = `${JSON.stringify(row)}\n`;
          await file.writeFile(value);
          hash.update(value);
          bytes += Buffer.byteLength(value);
          rows++;
        }
        await file.sync();
      } finally {
        await file.close();
      }
      tables.push({ name, rows, bytes, sha256: hash.digest('hex') });
    }
    const files = await expectedAssets(client);
    for (const file of files) await copyAsset(config.dataDir, join(root, archiveFiles), file);
    await client.commit();
    const manifest: ArchiveManifest = archiveManifestSchema.parse({
      format: 'memory-weave-backup',
      version: 1,
      schema: version,
      ownerId,
      createdAt: new Date().toISOString(),
      journal: { bytes: journal.raw.length, sha256: digestBytes(journal.raw) },
      tables,
      files,
    });
    await writeFile(join(root, 'manifest.json.tmp'), JSON.stringify(manifest, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
      flush: true,
    });
    await rename(join(root, 'manifest.json.tmp'), join(root, 'manifest.json'));
    return manifest;
  } catch (error) {
    if (created) await rm(root, { recursive: true, force: true });
    throw error;
  } finally {
    await lock.close();
  }
}

/** 完整核对包内容，失败时保持目标数据库和目录原状。 */
export async function inspectArchive(directory: string): Promise<ArchiveManifest> {
  const root = resolve(directory);
  const manifest = archiveManifestSchema.parse(
    JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')),
  );
  const tables = new Set<string>();
  for (const table of manifest.tables) {
    if (tables.has(table.name)) throw new Error('备份包含重复数据集。');
    tables.add(table.name);
    await assertFileDigest(tablePath(root, table.name), table);
  }
  const files = new Set<string>();
  for (const file of manifest.files) {
    if (files.has(file.path)) throw new Error('备份包含重复文件。');
    files.add(file.path);
    await assertFileDigest(join(root, archiveFiles, file.path), file);
  }
  return manifest;
}

/** 写入全新已迁移主库，先保留启动围栏，再应用当前独立限制。 */
export async function importArchive(
  config: ServerConfig,
  directory: string,
  replay: (
    manifest: ArchiveManifest,
    records: Awaited<ReturnType<typeof readLifecycleJournal>>['records'],
  ) => Promise<void>,
) {
  const root = resolve(directory);
  const journalDirectory = requireJournal(config, root);
  const manifest = await inspectArchive(root);
  const journal = await readLifecycleJournal(journalDirectory);
  verifyJournalPrefix(journal.raw, manifest.journal.bytes, manifest.journal.sha256);
  if (journal.records.some((row) => row.ownerId !== manifest.ownerId))
    throw new Error('独立生命周期日志所属部署不匹配。');
  await requireUnusedVectorOwner(config, manifest.ownerId);
  const lock = await acquireArchiveLock(config.databaseUrl);
  const client = lock.client;
  const marker = join(config.dataDir, restoreMarker);
  try {
    if ((await readyVersion(client)) !== manifest.schema)
      throw new Error('请用备份记录的对应发布版本恢复，再应用后续迁移。');
    const names = await tableNames(client);
    if (
      names.join(',') !==
      manifest.tables
        .map((table) => table.name)
        .sort()
        .join(',')
    )
      throw new Error('备份数据集与目标发布版本不一致。');
    for (const name of names.filter((table) => table !== 'owners')) {
      const [rows] = await client.query<RowDataPacket[]>(
        `SELECT 1 FROM ${identifier(name)} LIMIT 1`,
      );
      if (rows.length) throw new Error('恢复仅接受全新迁移的空数据库。');
    }
    const [bootstrapOwners] = await client.query<RowDataPacket[]>(
      'SELECT deployment_key, display_name FROM owners LIMIT 2',
    );
    if (
      bootstrapOwners.length !== 1 ||
      bootstrapOwners[0]?.deployment_key !== 'local' ||
      bootstrapOwners[0]?.display_name !== '用户'
    )
      throw new Error('目标数据库缺少全新迁移的部署身份。');
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    if ((await readdir(config.dataDir)).length) throw new Error('恢复仅接受空的文件目录。');
    await writeFile(marker, manifest.ownerId + '\n', { flag: 'wx', mode: 0o600, flush: true });
    await client.query("SET SESSION time_zone = '+00:00', FOREIGN_KEY_CHECKS = 0");
    await client.beginTransaction();
    try {
      await client.query('DELETE FROM owners');
      for (const table of manifest.tables) await restoreTable(client, root, table);
      if ((await onlyOwner(client)) !== manifest.ownerId) throw new Error('备份所属部署不匹配。');
      const assets = await expectedAssets(client);
      if (
        JSON.stringify(assets) !==
        JSON.stringify([...manifest.files].sort((a, b) => a.path.localeCompare(b.path)))
      )
        throw new Error('业务文件引用与备份清单不一致。');
      await checkForeignKeys(client);
      for (const asset of assets) await copyAsset(join(root, archiveFiles), config.dataDir, asset);
      await resetDerivedRuntime(client);
      await client.commit();
    } catch (error) {
      await client.rollback();
      throw error;
    } finally {
      await client.query('SET SESSION FOREIGN_KEY_CHECKS = 1');
    }
    await replay(manifest, journal.records);
    await writeFile(
      join(config.dataDir, restoreManifest),
      JSON.stringify(
        {
          format: 1,
          archiveCreatedAt: manifest.createdAt,
          appliedJournalRecords: journal.records.length,
          journalSha256: digestBytes(journal.raw),
          completedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx', mode: 0o600, flush: true },
    );
    await rm(marker);
    return manifest;
  } finally {
    await lock.close();
  }
}

/** 启动前拒绝曾中断的恢复目录，使尚未重放的限制不可见。 */
export async function assertRestoreReady(dataDir: string) {
  const marker = await readFile(join(dataDir, restoreMarker)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    },
  );
  if (marker) throw new Error('数据恢复尚未完成，请检查恢复报告并使用隔离空目标重新恢复。');
}

/** 取得离线备份约定的独立限制目录。 */
function requireJournal(config: ServerConfig, root: string) {
  if (!config.lifecycleJournalDir) throw new Error('请配置独立的生命周期日志目录。');
  assertSeparate(config.dataDir, config.lifecycleJournalDir);
  assertSeparate(config.dataDir, root);
  assertSeparate(config.lifecycleJournalDir, root);
  return config.lifecycleJournalDir;
}

/** 从当前数据库核对发布版本。 */
async function readyVersion(client: Connection) {
  const status = await querySchemaStatus(client);
  if (status.status !== 'ready' || !status.version)
    throw new Error('数据库需先完成当前发布版本的结构迁移。');
  return status.version;
}

/** 导出业务表，目标自行执行正式迁移。 */
async function tableNames(client: Connection) {
  const [rows] = await client.query<RowDataPacket[]>(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> '__memory_weave_migrations' ORDER BY TABLE_NAME",
  );
  const actual = rows.map((row) => z.string().parse(row.name)).sort();
  const expected = Object.values(schema).map(getTableName).sort();
  if (actual.join(',') !== expected.join(','))
    throw new Error('当前数据库包含发布清单之外或缺失的业务表。');
  return actual;
}

/** 当前部署只有本地用户，拒绝跨归属混合恢复。 */
async function onlyOwner(client: Connection) {
  const [owners] = await client.query<RowDataPacket[]>('SELECT id FROM owners LIMIT 2');
  if (owners.length !== 1) throw new Error('当前备份格式要求单部署账号。');
  return z.uuid().parse(owners[0]?.id);
}

/** 仅由受控数据集身份生成 JSONL 路径。 */
function tablePath(root: string, name: string) {
  identifier(name);
  return join(root, archiveTables, `${name}.jsonl`);
}

/** 通过权威记录计算确切文件清单，未发布的暂存副本不进入备份。 */
async function expectedAssets(client: Connection): Promise<ArchiveAsset[]> {
  const [materials] = await client.query<RowDataPacket[]>(
    'SELECT owner_id, file_id, hash, byte_length FROM material_versions WHERE file_id IS NOT NULL',
  );
  const [avatars] = await client.query<RowDataPacket[]>(
    'SELECT owner_id, id, avatar FROM companions WHERE avatar IS NOT NULL',
  );
  const map = new Map<string, ArchiveAsset>();
  for (const material of materials) {
    const path = `materials/${material.owner_id}/${material.file_id}`;
    map.set(path, {
      path,
      bytes: Number(material.byte_length),
      sha256: z.string().parse(material.hash),
    });
  }
  for (const row of avatars) {
    const avatar = z
      .object({ id: z.uuid(), hash: z.string(), byteLength: z.number().int() })
      .parse(row.avatar);
    const path = `avatars/${row.owner_id}/${row.id}/${avatar.id}.${avatar.hash}.webp`;
    map.set(path, { path, bytes: avatar.byteLength, sha256: avatar.hash });
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** 逐行导入具名列；任何非结构列或缺失列使整笔恢复失败。 */
async function restoreTable(
  client: Connection,
  root: string,
  table: ArchiveManifest['tables'][number],
) {
  const [columns] = await client.query<RowDataPacket[]>(
    'SELECT COLUMN_NAME AS name, DATA_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [table.name],
  );
  const names = columns.map((column) => z.string().parse(column.name));
  const sql = `INSERT INTO ${identifier(table.name)} (${names.map(identifier).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`;
  const lines = createInterface({
    input: createReadStream(tablePath(root, table.name)),
    crlfDelay: Infinity,
  });
  let count = 0;
  for await (const line of lines) {
    const row = rowSchema.parse(JSON.parse(line));
    if (Object.keys(row).length !== names.length || names.some((name) => !Object.hasOwn(row, name)))
      throw new Error('备份行与目标结构不一致。');
    await client.execute(
      sql,
      columns.map(({ name, type }) => {
        const value = row[z.string().parse(name)];
        if (value === undefined) throw new Error('备份行缺少字段。');
        return type === 'json' && value !== null ? JSON.stringify(value) : value;
      }),
    );
    count++;
  }
  if (count !== table.rows) throw new Error('备份的数据行数不一致。');
}

/** 恢复时临时推迟外键顺序，提交前验证全部关系。 */
async function checkForeignKeys(client: Connection) {
  const [fields] = await client.query<
    RowDataPacket[]
  >(`SELECT TABLE_NAME AS child, CONSTRAINT_NAME AS constraint_name, COLUMN_NAME AS child_col,
    REFERENCED_TABLE_NAME AS parent, REFERENCED_COLUMN_NAME AS parent_col FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`);
  const keys = new Map<string, typeof fields>();
  for (const field of fields) {
    const name = `${field.child}/${field.constraint_name}`;
    keys.set(name, [...(keys.get(name) ?? []), field]);
  }
  for (const rows of keys.values()) {
    const childCols = rows.map(
      ({ child_col }) => `child.${identifier(z.string().parse(child_col))}`,
    );
    const equal = rows
      .map(
        ({ parent_col }, index) =>
          `parent.${identifier(z.string().parse(parent_col))} = ${childCols[index]}`,
      )
      .join(' AND ');
    const [invalid] = await client.query<RowDataPacket[]>(
      `SELECT 1 FROM ${identifier(z.string().parse(rows[0]!.child))} child WHERE ${childCols.map((column) => `${column} IS NOT NULL`).join(' AND ')} AND NOT EXISTS (SELECT 1 FROM ${identifier(z.string().parse(rows[0]!.parent))} parent WHERE ${equal}) LIMIT 1`,
    );
    if (invalid.length) throw new Error('备份存在缺失的领域引用。');
  }
}

/** 重建派生索引并阻止快照里的旧设备连接直接生效。 */
async function resetDerivedRuntime(client: Connection) {
  await client.query(
    "UPDATE tasks SET status = 'cancelled', reason = 'archive_vector_rebuild', lease_token = NULL, lease_expires_at = NULL WHERE kind = 'memory_index' AND status IN ('queued','waiting','running','paused','blocked')",
  );
  await client.query('DELETE FROM memory_vector_indexes');
  await client.query("UPDATE terminal_actions SET state = 'unknown' WHERE state = 'dispatched'");
  await client.query(
    'UPDATE terminals SET connection_id = NULL, workspace_id = NULL, capabilities = NULL, expires_at = NULL WHERE connection_id IS NOT NULL',
  );
  await client.query(
    "UPDATE tasks SET status = 'waiting', available_at = CURRENT_TIMESTAMP(3), lease_token = NULL, lease_expires_at = NULL, reason = 'archive_resume_cleanup' WHERE kind = 'lifecycle_cleanup' AND status = 'running'",
  );
}

/** 减少误用旧物理索引的风险，恢复范围内既有集合必须由隔离目标提供。 */
async function requireUnusedVectorOwner(config: ServerConfig, ownerId: string) {
  const response = await fetch(`${config.qdrantUrl}/collections`, {
    headers: { 'api-key': config.qdrantApiKey },
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error('无法验证恢复目标的向量空间。');
  const data = z
    .object({ result: z.object({ collections: z.array(z.object({ name: z.string() })) }) })
    .parse(await response.json());
  const prefix = `mw_${ownerId.replaceAll('-', '')}_`;
  if (data.result.collections.some(({ name }) => name.startsWith(prefix)))
    throw new Error('恢复目标仍存在此部署的 Qdrant 集合，请提供隔离空间。');
}
