import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MaterialConfiguration } from './material-config';

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

export interface MaterialFileReference {
  /** 每个不可变原件由服务生成的独立文件身份。 */
  fileId: string;
  /** 原件 SHA-256 校验和。 */
  hash: string;
  /** 发布引用时已落盘的原件字节数。 */
  byteLength: number;
}

/** 原件不可静态访问。调用方负责认证、版本引用和任务围栏。 */
export class MaterialFiles {
  constructor(
    private readonly dataDir: string,
    private readonly limits: MaterialConfiguration,
  ) {}

  /**
   * 写入并同步完整原件，返回可在领域事务中发布的文件身份。
   * @param ownerId 可信领域归属。
   * @param bytes 已验证格式的原件字节。
   * @returns 独立不可变原件引用。
   */
  async save(ownerId: string, bytes: Buffer): Promise<MaterialFileReference> {
    if (!bytes.length || bytes.length > this.limits.maxFileBytes)
      throw new RangeError('material-file-size');
    const directory = this.directory(ownerId);
    const fileId = randomUUID();
    const path = join(directory, fileId);
    const temporary = path + '.upload';
    await mkdir(directory, { mode: 0o700, recursive: true });
    const hash = createHash('sha256').update(bytes).digest('hex');
    const file = await open(temporary, 'wx', 0o600);
    let installed = false;
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      // 原件完整写入后才出现最终文件名；硬链接避免覆盖已发布文件。
      await link(temporary, path);
      installed = true;
      await rm(temporary);
      if (process.platform !== 'win32') {
        const parent = await open(directory, 'r');
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      }
      return { fileId, hash, byteLength: bytes.length };
    } catch (error) {
      if (installed) await rm(path, { force: true }).catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * 从固定原件引用取得真实完整字节；缺失和损坏向上层报告失败。
   * @param ownerId 已通过领域校验的归属。
   * @param reference 当前仍有效的文件引用。
   * @returns 已核对字节数和哈希的原件。
   */
  async read(ownerId: string, reference: MaterialFileReference): Promise<Buffer> {
    const file = await open(this.path(ownerId, reference.fileId), 'r');
    try {
      const { size } = await file.stat();
      if (size !== reference.byteLength || size < 1 || size > this.limits.maxFileBytes)
        throw new Error('material-file-size');
      const buffer = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await file.read(buffer, offset, size - offset, offset);
        if (!bytesRead) throw new Error('material-file-size');
        offset += bytesRead;
      }
      if (createHash('sha256').update(buffer).digest('hex') !== reference.hash)
        throw new Error('material-file-checksum');
      return buffer;
    } finally {
      await file.close();
    }
  }

  /**
   * 清除原件，仅限持有材料清理围栏且已确认没有有效引用的调用方。
   * @param ownerId 当前归属。
   * @param fileId 不再使用的原件身份。
   */
  remove(ownerId: string, fileId: string): Promise<void> {
    return rm(this.path(ownerId, fileId), { force: true });
  }

  /** 检查一页超过保留期的文件，调用方须先确认数据库中无引用。 */
  async staleCandidates(
    ownerId: string,
    after: string,
    before: Date,
  ): Promise<{
    entries: { name: string; fileId: string; temporary: boolean }[];
    after: string;
  }> {
    const directory = this.directory(ownerId);
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const page = names
      .sort()
      .filter((name) => name > after)
      .slice(0, 32);
    const entries: { name: string; fileId: string; temporary: boolean }[] = [];
    for (const name of page) {
      const temporary = name.endsWith('.upload');
      const fileId = temporary ? name.slice(0, -'.upload'.length) : name;
      if (!UUID.test(fileId)) continue;
      const info = await stat(join(directory, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (info?.isFile() && info.mtime < before) entries.push({ name, fileId, temporary });
    }
    return { entries, after: page.length === 32 ? page.at(-1)! : '' };
  }

  /** 删除已检查的过期暂存文件；不会接受任意文件路径。 */
  removeTemporary(ownerId: string, fileId: string): Promise<void> {
    return rm(this.path(ownerId, fileId) + '.upload', { force: true });
  }

  private directory(ownerId: string): string {
    if (!UUID.test(ownerId)) throw new Error('invalid-owner-id');
    return join(this.dataDir, 'materials', ownerId);
  }

  private path(ownerId: string, fileId: string): string {
    if (!UUID.test(fileId)) throw new Error('invalid-material-file-id');
    return join(this.directory(ownerId), fileId);
  }
}
