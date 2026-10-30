import { z } from 'zod';
import { uuidSchema, utcDateTimeSchema, nonnegativeIntegerSchema } from './common';

/** 上传原图的字节上限；所有终端与服务端共用。 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** 允许上传的静态图片格式；服务端另行验证实际解码格式。 */
export const AVATAR_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const companionAvatarShape = {
  /** 此次图片的不可变身份，替换后旧地址失效。 */
  id: uuidSchema,
  /** 当前部署内、需要登录访问的图片地址。 */
  url: z.string().regex(/^\/api\/companions\/[\da-f-]{36}\/avatar\/[\da-f-]{36}$/),
  /** 实际保存和返回的图片格式。 */
  mimeType: z.literal('image/webp'),
  /** 规范化图片的像素宽度。 */
  width: z.literal(512),
  /** 规范化图片的像素高度。 */
  height: z.literal(512),
  /** 规范化图片的实际字节数。 */
  byteLength: z.number().int().positive(),
  /** 最近更换图片的 UTC 时间。 */
  updatedAt: utcDateTimeSchema,
};
/** 头像只属于展示资料，不进入人格版本或记忆。 */
export const companionAvatarSchema: z.ZodObject<typeof companionAvatarShape> =
  z.object(companionAvatarShape);
const avatarStateShape = {
  /** 自定义图片；null 表示显示默认月亮头像。 */
  avatar: companionAvatarSchema.nullable().default(null),
  /** 独立并发版本；不影响聊天内容版本与输入草稿。 */
  avatarVersion: nonnegativeIntegerSchema.default(0),
};
/** 上传及恢复默认后返回的当前展示状态。 */
export const avatarStateSchema: z.ZodObject<typeof avatarStateShape> = z.object(avatarStateShape);
const changeAvatarShape = {
  /** 本次命令身份；上传失败重试时沿用。 */
  requestId: uuidSchema,
  /** 操作时看到的实例代次，防止跨重置提交。 */
  runtimeEpoch: z.coerce.number().int().min(1).max(2147483647),
  /** 操作时看到的头像版本，防止覆盖其他终端的修改。 */
  expectedVersion: z.coerce.number().int().min(0).max(2147483647),
};
/** 上传使用查询参数，恢复默认使用 JSON 正文。 */
export const changeAvatarSchema: z.ZodObject<typeof changeAvatarShape, z.core.$strict> = z
  .object(changeAvatarShape)
  .strict();
/** 可公开读取的图片资料。 */
export type CompanionAvatar = z.infer<typeof companionAvatarSchema>;
/** 当前图片及其独立版本。 */
export type AvatarState = z.infer<typeof avatarStateSchema>;
/** 修改头像的命令元数据。 */
export type ChangeAvatar = z.infer<typeof changeAvatarSchema>;
