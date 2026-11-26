import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { z } from 'zod';

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const tableName = z.string().regex(/^[a-z][a-z_0-9]*$/);
const bytes = z.number().int().nonnegative();
const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const assetPath = new RegExp(
  `^(?:materials/${uuid}/${uuid}|avatars/${uuid}/${uuid}/${uuid}\\.[0-9a-f]{64}\\.webp)$`,
);
const digestFields = { bytes, sha256: sha };
export const archiveManifestSchema = z.strictObject({
  format: z.literal('memory-weave-backup'),
  version: z.literal(1),
  schema: z.string().regex(/^\d{4}_[a-z_0-9]+$/),
  ownerId: z.uuid(),
  createdAt: z.iso.datetime(),
  journal: z.strictObject(digestFields),
  tables: z.array(z.strictObject({ name: tableName, rows: bytes, ...digestFields })).max(256),
  files: z.array(z.strictObject({ path: z.string().regex(assetPath), ...digestFields })),
});
export type ArchiveManifest = z.infer<typeof archiveManifestSchema>;
export type ArchiveAsset = ArchiveManifest['files'][number];

/** 校验受控标识符，禁止把备份文本当作 SQL。 */
export function identifier(value: string) {
  return `\`${tableName.parse(value)}\``;
}

/** 校验受控的头像或材料相对路径。 */
export function assetLocation(directory: string, path: string) {
  return join(directory, z.string().regex(assetPath).parse(path));
}

/** 检查存储和备份目录互不包含。 */
export function assertSeparate(left: string, right: string) {
  const l = relative(left, right);
  const r = relative(right, left);
  if (!(l === '..' || l.startsWith(`..${sep}`)) || !(r === '..' || r.startsWith(`..${sep}`)))
    throw new Error('文件、独立日志和备份目录必须分开。');
}

/** 保持大资源以流方式读取，校验大小和内容。 */
export async function fileDigest(path: string) {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error('备份文件必须为普通文件。');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += Buffer.byteLength(chunk);
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}

/** 一次复制只允许新的目标，每个业务文件与权威清单核对。 */
export async function copyAsset(from: string, to: string, file: ArchiveAsset) {
  const source = assetLocation(from, file.path);
  const target = assetLocation(to, file.path);
  if (!(await stat(source)).isFile()) throw new Error('备份缺少业务文件。');
  await assertFileDigest(source, file);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(source, target, constants.COPYFILE_EXCL);
  await chmod(target, 0o600);
  await assertFileDigest(target, file);
  const descriptor = await open(target, 'r');
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

/** 核对实际文件内容与清单。 */
export async function assertFileDigest(path: string, expected: { bytes: number; sha256: string }) {
  const actual = await fileDigest(path);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
    throw new Error('备份大小或校验值不一致。');
}
