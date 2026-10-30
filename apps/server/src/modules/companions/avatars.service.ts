import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { and, eq } from 'drizzle-orm';
import { API_CODES, AVATAR_MAX_BYTES, AVATAR_MEDIA_TYPES } from '@memory-weave/contracts';
import type { AvatarState, ChangeAvatar } from '@memory-weave/contracts';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import { companions } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { AvatarFiles, publicAvatar } from './avatar-files';

/** 头像独立于人格与原文；当前图片只通过带归属检查的接口读取。 */
@Injectable()
export class AvatarsService {
  private processing = 0;
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AvatarFiles) private readonly files: AvatarFiles,
  ) {}
  private async lock(ownerId: string, id: string, tx: DatabaseTransaction) {
    const [row] = await tx
      .select()
      .from(companions)
      .where(and(eq(companions.ownerId, ownerId), eq(companions.id, id)))
      .for('update');
    if (!row || row.deletedAt) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    return row;
  }
  private validate(row: typeof companions.$inferSelect, input: ChangeAvatar): void {
    if (row.lifecycleOperationId) throw new ApiException(API_CODES.LIFECYCLE_RESTRICTED);
    if (row.runtimeEpoch !== input.runtimeEpoch)
      throw new ApiException(API_CODES.RUNTIME_EPOCH_MISMATCH);
  }
  /** 有界解码、去除 EXIF 并归一为正方形 WebP；拒绝动画和伪装格式。 */
  async upload(id: string, input: ChangeAvatar, mime: string, body: unknown): Promise<AvatarState> {
    if (!AVATAR_MEDIA_TYPES.includes(mime as (typeof AVATAR_MEDIA_TYPES)[number]))
      throw new ApiException(
        API_CODES.UNSUPPORTED_MEDIA_TYPE,
        '请选择 JPG、PNG 或 WebP 静态图片。',
      );
    if (!Buffer.isBuffer(body) || !body.length)
      throw new ApiException(API_CODES.INVALID_REQUEST, '请选择有效图片。');
    if (body.length > AVATAR_MAX_BYTES) throw new ApiException(API_CODES.REQUEST_BODY_TOO_LARGE);
    // 解码前检查实例与版本，处理后仍在事务内再次检查，防止迟到上传跨越重置。
    await this.database.withOwner((owner, db) =>
      db.transaction(async (tx) => this.validate(await this.lock(owner, id, tx), input)),
    );
    if (this.processing >= 2)
      throw new ApiException(API_CODES.RATE_LIMITED, '正在处理图片，请稍后重试。');
    this.processing++;
    let bytes: Buffer;
    try {
      const image = sharp(body, { limitInputPixels: 16_777_216, failOn: 'warning' });
      const metadata = await image.metadata();
      if (
        `image/${metadata.format}` !== mime ||
        (metadata.pages ?? 1) > 1 ||
        (metadata.format === 'png' && hasAnimationControl(body))
      )
        throw new Error('无效图片格式');
      bytes = await image
        .rotate()
        .resize(512, 512, { fit: 'cover' })
        .webp({ quality: 86 })
        .toBuffer();
    } catch {
      throw new ApiException(
        API_CODES.INVALID_REQUEST,
        '无法读取图片，请使用不超过 1600 万像素的 JPG、PNG 或 WebP 静态图片。',
      );
    } finally {
      this.processing--;
    }
    const inputHash = createHash('sha256').update(body).digest('hex');
    const avatar = {
      id: randomUUID(),
      requestId: input.requestId.toLowerCase(),
      inputHash,
      hash: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
      updatedAt: new Date().toISOString(),
    };
    return this.database.withOwner((ownerId, db) =>
      db.transaction(
        async (tx) => {
          const row = await this.lock(ownerId, id, tx);
          this.validate(row, input);
          if (row.avatar?.requestId === avatar.requestId) {
            if (
              row.avatar.inputHash !== inputHash ||
              row.avatarVersion !== input.expectedVersion + 1
            )
              throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
            return { avatar: publicAvatar(id, row.avatar), avatarVersion: row.avatarVersion };
          }
          if (row.avatarVersion !== input.expectedVersion)
            throw new ApiException(API_CODES.VERSION_CONFLICT);
          if (row.avatarVersion === 2147483647)
            throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
          await this.files.save(ownerId, id, avatar, bytes);
          await tx
            .update(companions)
            .set({ avatar, avatarVersion: row.avatarVersion + 1 })
            .where(eq(companions.id, id));
          return { avatar: publicAvatar(id, avatar), avatarVersion: row.avatarVersion + 1 };
        },
        { isolationLevel: 'read committed' },
      ),
    );
  }
  /** 恢复默认允许安全重放；旧版本不能覆盖已经更换的新图片。 */
  clear(id: string, input: ChangeAvatar): Promise<AvatarState> {
    return this.database.withOwner((ownerId, db) =>
      db.transaction(
        async (tx) => {
          const row = await this.lock(ownerId, id, tx);
          this.validate(row, input);
          if (!row.avatar) return { avatar: null, avatarVersion: row.avatarVersion };
          if (row.avatarVersion !== input.expectedVersion)
            throw new ApiException(API_CODES.VERSION_CONFLICT);
          if (row.avatarVersion === 2147483647)
            throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
          await tx
            .update(companions)
            .set({ avatar: null, avatarVersion: row.avatarVersion + 1 })
            .where(eq(companions.id, id));
          return { avatar: null, avatarVersion: row.avatarVersion + 1 };
        },
        { isolationLevel: 'read committed' },
      ),
    );
  }
  /** 旧图片 URL 在替换或删除后立即失效；持锁避免检查后读到被替换文件。 */
  read(id: string, assetId: string): Promise<Buffer> {
    return this.database.withOwner((ownerId, db) =>
      db.transaction(async (tx) => {
        const row = await this.lock(ownerId, id, tx);
        if (!row.avatar || row.avatar.id !== assetId.toLowerCase())
          throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
        return this.files.read(ownerId, id, row.avatar);
      }),
    );
  }
}

/** PNG 解码器可能只暴露首帧，单独检查有界块结构，不能把 APNG 当作静态图。 */
function hasAnimationControl(bytes: Buffer): boolean {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') return true;
    if (length > bytes.length - offset - 12) return false;
    offset += length + 12;
  }
  return false;
}
