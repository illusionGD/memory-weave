import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = new URL('../', import.meta.url);
const destination = new URL('.env', root);
const template = await readFile(new URL('.env.example', root), 'utf8');
let original;
try {
  original = await readFile(destination, 'utf8');
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
let contents = original ?? template;
const existing = parseEnv(contents);
const legacy = /^postgres(?:ql)?:/.test(existing.DATABASE_URL ?? '');

/** 补齐缺项；已有的部署密码与 MySQL 凭据保持不变。 */
function configure(key, fallback) {
  if (existing[key]) return existing[key];
  replace(key, fallback);
  existing[key] = fallback;
  return fallback;
}

/** 写入固定配置键，不把密码或连接串打印到终端。 */
function replace(key, value) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  contents = pattern.test(contents)
    ? contents.replace(pattern, () => `${key}=${value}`)
    : `${contents.trimEnd()}\n${key}=${value}\n`;
}

const databasePassword = configure('MYSQL_PASSWORD', randomBytes(24).toString('hex'));
configure('MYSQL_ROOT_PASSWORD', randomBytes(24).toString('hex'));
const mysqlPort = configure('MYSQL_PORT', '3306');
const qdrantPort = configure('QDRANT_PORT', '6333');
configure('QDRANT_URL', `http://127.0.0.1:${qdrantPort}`);
configure('QDRANT_API_KEY', randomBytes(24).toString('hex'));
configure('ADMIN_PASSWORD', randomBytes(24).toString('base64url'));

if (legacy || !existing.DATABASE_URL) {
  const databaseUrl = new URL('mysql://127.0.0.1/memory_weave');
  databaseUrl.port = mysqlPort;
  databaseUrl.username = 'memory_weave';
  databaseUrl.password = encodeURIComponent(databasePassword);
  replace('DATABASE_URL', databaseUrl.toString());
}

if (legacy && original !== undefined) {
  try {
    await writeFile(new URL('.env.postgresql-backup', root), original, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
}

if (contents !== original) {
  const temporary = new URL(`.env.${randomBytes(8).toString('hex')}.tmp`, root);
  await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
  await rename(temporary, destination);
  console.log(
    `已${original === undefined ? '生成' : '补齐'} ${fileURLToPath(destination)}，请在文件中查看登录密码。`,
  );
  if (legacy)
    console.log(
      '已切换为全新 MySQL 配置；旧配置备份到 .env.postgresql-backup，不导入或删除旧 PostgreSQL 数据。',
    );
} else {
  console.log('.env 配置已齐全，保留现有值。');
}
