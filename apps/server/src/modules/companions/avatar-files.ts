import { Inject, Injectable } from '@nestjs/common';
import { mkdir, open, readFile, rm, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { SERVER_CONFIG } from '../../config';
import type { RuntimeConfig } from '../../config';
import type { CompanionAvatar } from '@memory-weave/contracts';

/** 数据库存储的文件引用与上传指纹，不向终端暴露内部散列或路径。 */
export interface StoredAvatar {
  /** 当前图片身份，由服务端生成，不随命令键复用。 */
  id: string;
  /** 上传命令的幂等键。 */
  requestId: string;
  /** 原图指纹用于识别同键异载荷。 */
  inputHash: string;
  /** 规范化文件校验和用于生成不可变文件名。 */
  hash: string;
  /** 文件实际大小。 */
  byteLength: number;
  /** 发布时间。 */
  updatedAt: string;
}
/** 只输出可认证读取的公共引用。 */
export function publicAvatar(id: string, avatar: StoredAvatar | null): CompanionAvatar | null {
  return avatar
    ? {
        id: avatar.id,
        url: `/api/companions/${id}/avatar/${avatar.id}`,
        mimeType: 'image/webp',
        width: 512,
        height: 512,
        byteLength: avatar.byteLength,
        updatedAt: avatar.updatedAt,
      }
    : null;
}
/** 图片目录仅由服务端 UUID 组成；调用方须持有实例锁或生命周期删除围栏。 */
@Injectable()
export class AvatarFiles {
  constructor(@Inject(SERVER_CONFIG) private readonly config: RuntimeConfig) {}
  private directory(ownerId: string, id: string): string {
    return join(this.config.dataDir, 'avatars', ownerId, id);
  }
  private filename(avatar: StoredAvatar): string {
    return `${avatar.id}.${avatar.hash}.webp`;
  }
  /** 文件完整写入并同步后，调用方才能发布数据库引用。 */
  async save(ownerId: string, id: string, avatar: StoredAvatar, bytes: Buffer): Promise<void> {
    const directory = this.directory(ownerId, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, this.filename(avatar));
    // 新文件身份由服务端生成，绝不覆盖已经发布的图片。
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    if (process.platform !== 'win32') {
      const parent = await open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  }
  /** 不提供静态目录暴露，先经领域认证与当前引用检查再读取。 */
  read(ownerId: string, id: string, avatar: StoredAvatar): Promise<Buffer> {
    return readFile(join(this.directory(ownerId, id), this.filename(avatar)));
  }
  /** 有界回收未引用的文件；持实例锁，不能删到尚未提交的新头像。 */
  async prune(ownerId: string, id: string, avatar: StoredAvatar | null): Promise<void> {
    let directory;
    try {
      directory = await opendir(this.directory(ownerId, id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let count = 0;
    for await (const entry of directory) {
      if (entry.isFile() && entry.name !== (avatar && this.filename(avatar)))
        await rm(join(this.directory(ownerId, id), entry.name), { force: true });
      if (++count >= 32) break;
    }
  }
  /** 删除实例的持久清理阶段，可在中断后重复执行。 */
  removeAll(ownerId: string, id: string): Promise<void> {
    return rm(this.directory(ownerId, id), { recursive: true, force: true });
  }
}
