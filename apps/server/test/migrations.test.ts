import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from './support/database';

const execute = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/database/migrate-cli.ts', import.meta.url));
const temporaryDirectories: string[] = [];
const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];

async function createMigrations(sources: string[]) {
  const migrationDir = await mkdtemp(join(tmpdir(), 'memory-weave-migrations-'));
  temporaryDirectories.push(migrationDir);
  await mkdir(join(migrationDir, 'meta'));
  const entries = sources.map((_, index) => ({
    idx: index,
    version: '7',
    when: 1_700_000_000_000 + index,
    tag: `${String(index).padStart(4, '0')}_fixture`,
    breakpoints: true,
  }));
  await writeFile(
    join(migrationDir, 'meta/_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
  );
  await Promise.all(
    sources.map((source, index) =>
      writeFile(join(migrationDir, `${entries[index]!.tag}.sql`), source),
    ),
  );
  return migrationDir;
}

async function isolatedDatabase() {
  const database = await createTestDatabase({ migrate: false });
  databases.push(database);
  return database.databaseUrl;
}

async function invokeCli(databaseUrl: string, migrationDir: string, command = 'migrate') {
  try {
    const result = await execute(
      process.execPath,
      ['--import', 'tsx', cliPath, command, '--migrations-dir', migrationDir],
      { env: { ...process.env, DATABASE_URL: databaseUrl } },
    );
    return { code: 0, ...result };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.dispose()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('migration command with PostgreSQL', () => {
  it('applies a release once and reports the same ready version on repeat deployment', async () => {
    const databaseUrl = await isolatedDatabase();
    const migrationDir = await createMigrations([
      'CREATE TABLE migration_marker (id integer PRIMARY KEY);',
    ]);
    const before = await invokeCli(databaseUrl, migrationDir, 'status');
    expect(JSON.parse(before.stdout)).toEqual({ status: 'pending', version: null });

    const first = await invokeCli(databaseUrl, migrationDir);
    expect(first.code, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({
      status: 'ready',
      version: '0000_fixture',
      applied: 1,
    });
    const repeated = await invokeCli(databaseUrl, migrationDir);
    expect(repeated.code, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout)).toEqual({
      status: 'ready',
      version: '0000_fixture',
      applied: 0,
    });
    const status = await invokeCli(databaseUrl, migrationDir, 'status');
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual({ status: 'ready', version: '0000_fixture' });
  });

  it('serializes simultaneous deployments so each migration is applied exactly once', async () => {
    const databaseUrl = await isolatedDatabase();
    const migrationDir = await createMigrations([
      'SELECT pg_sleep(0.5);\n--> statement-breakpoint\nCREATE TABLE deployment_marker (id integer PRIMARY KEY);',
    ]);
    const results = await Promise.all([
      invokeCli(databaseUrl, migrationDir),
      invokeCli(databaseUrl, migrationDir),
    ]);
    expect(
      results.map((result) => result.code),
      results.map((result) => result.stderr).join('\n'),
    ).toEqual([0, 0]);
    expect(results.map((result) => JSON.parse(result.stdout).applied).sort()).toEqual([0, 1]);
    const status = await invokeCli(databaseUrl, migrationDir, 'status');
    expect(JSON.parse(status.stdout)).toEqual({ status: 'ready', version: '0000_fixture' });
  });

  it('rolls back the entire failed release and can apply the repaired release without partial tables', async () => {
    const databaseUrl = await isolatedDatabase();
    const migrationDir = await createMigrations([
      'CREATE TABLE transaction_marker (id integer PRIMARY KEY);',
      'SELECT * FROM never_print_private_failure_detail;',
    ]);
    const failed = await invokeCli(databaseUrl, migrationDir);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('Database migration failed.');
    expect(failed.stderr + failed.stdout).not.toContain('never_print_private_failure_detail');
    const status = await invokeCli(databaseUrl, migrationDir, 'status');
    expect(JSON.parse(status.stdout)).toEqual({ status: 'pending', version: null });

    await writeFile(
      join(migrationDir, '0001_fixture.sql'),
      'CREATE TABLE repaired_marker (id integer PRIMARY KEY);',
    );
    const repaired = await invokeCli(databaseUrl, migrationDir);
    expect(repaired.code, repaired.stderr).toBe(0);
    expect(JSON.parse(repaired.stdout)).toEqual({
      status: 'ready',
      version: '0001_fixture',
      applied: 2,
    });
  });

  it('rejects changes to already applied SQL instead of treating the release as ready', async () => {
    const databaseUrl = await isolatedDatabase();
    const migrationDir = await createMigrations([
      'CREATE TABLE history_marker (id integer PRIMARY KEY);',
    ]);
    const first = await invokeCli(databaseUrl, migrationDir);
    expect(first.code, first.stderr).toBe(0);
    await writeFile(
      join(migrationDir, '0000_fixture.sql'),
      'CREATE TABLE changed_history_marker (id integer PRIMARY KEY);',
    );

    const status = await invokeCli(databaseUrl, migrationDir, 'status');
    expect(status.code).toBe(1);
    expect(JSON.parse(status.stdout)).toEqual({ status: 'unavailable', version: null });
    const changed = await invokeCli(databaseUrl, migrationDir);
    expect(changed.code).toBe(1);
    expect(changed.stderr).toContain('Migration history does not match this release.');
  });

  it('reports appended migrations as pending and rejects an older release after upgrading', async () => {
    const databaseUrl = await isolatedDatabase();
    const originalSql = 'CREATE TABLE original_marker (id integer PRIMARY KEY);';
    const oldDirectory = await createMigrations([originalSql]);
    const newDirectory = await createMigrations([
      originalSql,
      'CREATE TABLE upgrade_marker (id integer PRIMARY KEY);',
    ]);
    const original = await invokeCli(databaseUrl, oldDirectory);
    expect(original.code, original.stderr).toBe(0);
    const pending = await invokeCli(databaseUrl, newDirectory, 'status');
    expect(JSON.parse(pending.stdout)).toEqual({ status: 'pending', version: '0000_fixture' });
    const upgraded = await invokeCli(databaseUrl, newDirectory);
    expect(upgraded.code, upgraded.stderr).toBe(0);
    expect(JSON.parse(upgraded.stdout)).toEqual({
      status: 'ready',
      version: '0001_fixture',
      applied: 1,
    });

    const oldStatus = await invokeCli(databaseUrl, oldDirectory, 'status');
    expect(oldStatus.code).toBe(1);
    expect(JSON.parse(oldStatus.stdout)).toEqual({ status: 'unavailable', version: null });
    const oldRelease = await invokeCli(databaseUrl, oldDirectory);
    expect(oldRelease.code).toBe(1);
    expect(oldRelease.stderr).toContain('Migration history does not match this release.');
  });
});

describe('migration command', () => {
  it('rejects incomplete migration files without disclosing database credentials', async () => {
    const migrationDir = await mkdtemp(join(tmpdir(), 'memory-weave-migrations-'));
    temporaryDirectories.push(migrationDir);
    const result = await invokeCli(
      'postgresql://private:must-not-appear@127.0.0.1:1/unavailable',
      migrationDir,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Migration files are invalid.');
    expect(result.stdout + result.stderr).not.toContain('must-not-appear');
    const status = await invokeCli(
      'postgresql://private:must-not-appear@127.0.0.1:1/unavailable',
      migrationDir,
      'status',
    );
    expect(status.code).toBe(1);
    expect(JSON.parse(status.stdout)).toEqual({ status: 'unavailable', version: null });
  });

  it('reports malformed connection settings as unavailable without exposing their contents', async () => {
    const migrationDir = await createMigrations(['CREATE TABLE migration_marker (id integer);']);
    const status = await invokeCli('postgresql://private:must-not-appear@', migrationDir, 'status');
    expect(status.code).toBe(1);
    expect(JSON.parse(status.stdout)).toEqual({ status: 'unavailable', version: null });
    expect(status.stdout + status.stderr).not.toContain('must-not-appear');
  });

  it('rejects ambiguous migration ordering before attempting a database connection', async () => {
    const migrationDir = await createMigrations(['SELECT 1;', 'SELECT 2;']);
    await writeFile(
      join(migrationDir, 'meta/_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [
          { idx: 0, version: '7', when: 1000, tag: '0000_fixture', breakpoints: true },
          { idx: 1, version: '7', when: 1000, tag: '0001_fixture', breakpoints: true },
        ],
      }),
    );
    const result = await invokeCli(
      'postgresql://private:must-not-appear@127.0.0.1:1/unavailable',
      migrationDir,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Migration files are invalid.');
  });

  it('returns a controlled failure when the configured database is unavailable', async () => {
    const migrationDir = await createMigrations(['CREATE TABLE migration_marker (id integer);']);
    const result = await invokeCli(
      'postgresql://private:must-not-appear@127.0.0.1:1/unavailable',
      migrationDir,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Database migration failed.');
    expect(result.stdout + result.stderr).not.toContain('must-not-appear');
  });
});
