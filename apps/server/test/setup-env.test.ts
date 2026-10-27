import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadServerConfig } from '../src/config';

const execute = promisify(execFile);
const directories: string[] = [];

async function workspace(initial?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'memory-weave-setup-'));
  directories.push(directory);
  await mkdir(join(directory, 'scripts'));
  await writeFile(
    join(directory, 'scripts/setup-env.mjs'),
    await readFile(new URL('../../../scripts/setup-env.mjs', import.meta.url)),
  );
  await writeFile(
    join(directory, '.env.example'),
    await readFile(new URL('../../../.env.example', import.meta.url)),
  );
  if (initial !== undefined) await writeFile(join(directory, '.env'), initial);
  return {
    directory,
    run: () => execute(process.execPath, ['scripts/setup-env.mjs'], { cwd: directory }),
    read: () => readFile(join(directory, '.env'), 'utf8'),
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('部署配置生成命令', () => {
  it('creates usable MySQL/Qdrant settings without printing credentials', async () => {
    const project = await workspace();
    const result = await project.run();
    const environment = parseEnv(await project.read());
    const config = loadServerConfig(environment);
    expect(new URL(config.databaseUrl).protocol).toBe('mysql:');
    expect(new URL(config.databaseUrl).password).toBe(environment.MYSQL_PASSWORD);
    expect(config.qdrantUrl).toBe('http://127.0.0.1:6333');
    for (const key of [
      'MYSQL_PASSWORD',
      'MYSQL_ROOT_PASSWORD',
      'QDRANT_API_KEY',
      'ADMIN_PASSWORD',
    ]) {
      expect(environment[key]?.length).toBeGreaterThanOrEqual(12);
      expect(result.stdout + result.stderr).not.toContain(environment[key]);
    }
  });

  it('switches old PostgreSQL configuration once, preserving login and a private backup', async () => {
    const original =
      'DATABASE_URL=postgresql://old:private-old-db@localhost/memory_weave\nADMIN_PASSWORD=keep-this-login-password\nDATA_DIR=./existing-data\n';
    const project = await workspace(original);
    await project.run();
    const updated = await project.read();
    const environment = parseEnv(updated);
    expect(loadServerConfig(environment).databaseUrl).toMatch(/^mysql:/);
    expect(environment.ADMIN_PASSWORD).toBe('keep-this-login-password');
    expect(environment.DATA_DIR).toBe('./existing-data');
    expect(await readFile(join(project.directory, '.env.postgresql-backup'), 'utf8')).toBe(
      original,
    );
    await project.run();
    expect(await project.read()).toBe(updated);
  });

  it('preserves an existing custom MySQL URL and all configured credentials', async () => {
    const original =
      'DATABASE_URL=mysql://custom:private-db@localhost:3307/custom_db\nMYSQL_PORT=3307\nMYSQL_PASSWORD=keep-database-password\nMYSQL_ROOT_PASSWORD=keep-root-password\nQDRANT_API_KEY=keep-vector-api-key\nADMIN_PASSWORD=keep-admin-password\n';
    const project = await workspace(original);
    await project.run();
    const updated = parseEnv(await project.read());
    for (const [key, value] of Object.entries(parseEnv(original))) expect(updated[key]).toBe(value);
  });
});
