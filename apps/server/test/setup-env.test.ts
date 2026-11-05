import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadServerConfig } from '../src/config';

const execute = promisify(execFile);
const directories: string[] = [];

/** 创建环境配置脚本的临时验收工作区。 */
async function workspace(initial?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'memory-weave-setup-'));
  directories.push(directory);
  await mkdir(join(directory, 'scripts'));
  await cp(new URL('../../../config/', import.meta.url), join(directory, 'config'), {
    recursive: true,
    filter: (source) => !/models\.(development|production)\.json$/.test(source),
  });
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
    /** 在临时工作区运行环境配置脚本。 */
    run: () => execute(process.execPath, ['scripts/setup-env.mjs'], { cwd: directory }),
    /** 读取临时工作区生成的配置文件。 */
    read: () => readFile(join(directory, '.env'), 'utf8'),
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('部署配置生成命令', () => {
  it('adds stable Redis credentials and namespace without rotating existing deployments', async () => {
    const project = await workspace(
      'ADMIN_PASSWORD=keep-existing-login-password\nREDIS_PORT=6381\n',
    );
    const result = await project.run();
    const first = await project.read();
    const environment = parseEnv(first);
    expect(environment.AUTH_SESSION_SECRET).toMatch(/^[a-f0-9]{64}$/);
    expect(environment.REDIS_NAMESPACE).toMatch(/^memory-weave:[a-f0-9]{16}$/);
    const redisUrl = new URL(environment.REDIS_URL!);
    expect(redisUrl.protocol).toBe('redis:');
    expect(redisUrl.port).toBe('6381');
    expect(decodeURIComponent(redisUrl.password)).toBe(environment.REDIS_PASSWORD);
    expect(environment.ADMIN_PASSWORD).toBe('keep-existing-login-password');
    for (const key of ['REDIS_PASSWORD', 'AUTH_SESSION_SECRET', 'REDIS_URL']) {
      expect(result.stdout + result.stderr).not.toContain(environment[key]);
    }
    await project.run();
    expect(await project.read()).toBe(first);
  });

  it('creates usable MySQL/Qdrant/Redis settings without printing credentials', async () => {
    const project = await workspace();
    const result = await project.run();
    const environment: Record<string, string> = {
      ...parseEnv(await project.read()),
      MODEL_CONFIG_FILE: join(project.directory, 'config/models.development.json'),
    };
    const config = loadServerConfig(environment);
    expect(new URL(config.databaseUrl).protocol).toBe('mysql:');
    expect(new URL(config.databaseUrl).password).toBe(environment.MYSQL_PASSWORD);
    expect(config.qdrantUrl).toBe('http://127.0.0.1:6333');
    expect(new URL(config.redisUrl).hostname).toBe('127.0.0.1');
    for (const key of [
      'MYSQL_PASSWORD',
      'MYSQL_ROOT_PASSWORD',
      'QDRANT_API_KEY',
      'ADMIN_PASSWORD',
      'REDIS_PASSWORD',
      'AUTH_SESSION_SECRET',
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
    const environment: Record<string, string> = {
      ...parseEnv(updated),
      MODEL_CONFIG_FILE: join(project.directory, 'config/models.development.json'),
    };
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
      'DATABASE_URL=mysql://custom:private-db@localhost:3307/custom_db\nMYSQL_PORT=3307\nMYSQL_PASSWORD=keep-database-password\nMYSQL_ROOT_PASSWORD=keep-root-password\nQDRANT_API_KEY=keep-vector-api-key\nADMIN_PASSWORD=keep-admin-password\nREDIS_URL=rediss://custom:keep-redis-password@cache.example.com:6380/2\nREDIS_PASSWORD=keep-redis-password\nREDIS_NAMESPACE=private-space:existing\nAUTH_SESSION_SECRET=607346cae457823da89f74be1f260593cc9b6c95b5063f77b14adfe0d0491c5a8\n';
    const project = await workspace(original);
    await project.run();
    const updated = parseEnv(await project.read());
    for (const [key, value] of Object.entries(parseEnv(original))) expect(updated[key]).toBe(value);
  });
});
