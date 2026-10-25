import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const destination = new URL('.env', root);
const template = await readFile(new URL('.env.example', root), 'utf8');
const databasePassword = randomBytes(24).toString('hex');
const adminPassword = randomBytes(24).toString('base64url');
const contents = template
  .replace(/^POSTGRES_PASSWORD=.*$/m, `POSTGRES_PASSWORD=${databasePassword}`)
  .replace(/^ADMIN_PASSWORD=.*$/m, `ADMIN_PASSWORD=${adminPassword}`)
  .replace(
    /^DATABASE_URL=.*$/m,
    `DATABASE_URL=postgresql://memory_weave:${databasePassword}@127.0.0.1:5432/memory_weave`,
  );

try {
  await writeFile(destination, contents, { flag: 'wx', mode: 0o600 });
  console.log(`已生成 ${fileURLToPath(destination)}。请在该文件中查看 ADMIN_PASSWORD 用于登录。`);
  console.log('密码不会打印到日志。已有数据库卷请使用原数据库凭据，不要重新生成后直接替换。');
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
    console.log('.env 已存在，保留现有配置。');
  } else {
    throw error;
  }
}
