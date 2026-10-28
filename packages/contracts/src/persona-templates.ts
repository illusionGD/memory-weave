import { z } from 'zod';
import { positiveIntegerSchema, utcDateTimeSchema, uuidSchema } from './common';

/** 用户明确要求长期保留的约束；普通性格描述无需填入。 */
export const lockedFeaturesSchema = z.array(z.string().trim().min(1).max(300)).max(20);

const templateInputShape = {
  /** 保存命令的幂等标识。 */
  requestId: uuidSchema,
  /** 模板名称，不等同于伴侣姓名。 */
  name: z.string().trim().min(1).max(80),
  /** 保留原始人设，后续创建时独立整理。 */
  initialProfile: z
    .string()
    .min(1)
    .max(4000)
    .refine((text) => text.trim().length > 0),
  /** 可选的明确锁定约束。 */
  lockedFeatures: lockedFeaturesSchema.default([]),
};
/** 创建可复用的人设模板。 */
export const createPersonaTemplateSchema: z.ZodObject<typeof templateInputShape, z.core.$strict> = z
  .object(templateInputShape)
  .strict();

const updateTemplateShape = {
  /** 本次编辑的幂等标识。 */
  requestId: templateInputShape.requestId,
  /** 新版本的模板名称。 */
  name: templateInputShape.name,
  /** 新版本的完整原稿，旧版本不覆盖。 */
  initialProfile: templateInputShape.initialProfile,
  /** 新版本明确保留的约束。 */
  lockedFeatures: templateInputShape.lockedFeatures,
  /** 调用方当前所见版本，防止覆盖并发编辑。 */
  expectedVersion: positiveIntegerSchema,
};
/** 追加模板新版本。 */
export const updatePersonaTemplateSchema: z.ZodObject<typeof updateTemplateShape, z.core.$strict> =
  z.object(updateTemplateShape).strict();
/** 追加模板版本的请求。 */
export type UpdatePersonaTemplate = z.infer<typeof updatePersonaTemplateSchema>;

const templateShape = {
  /** 模板的稳定标识，各版本共享。 */
  id: uuidSchema,
  /** 不可变版本号。 */
  version: positiveIntegerSchema,
  /** 此版本的模板名称。 */
  name: templateInputShape.name,
  /** 此版本的原始人设。 */
  initialProfile: templateInputShape.initialProfile,
  /** 此版本的明确锁定约束。 */
  lockedFeatures: lockedFeaturesSchema,
  /** 此版本的创建时间。 */
  createdAt: utcDateTimeSchema,
};
/** 模板版本；更新不能修改已创建实例。 */
export const personaTemplateSchema: z.ZodObject<typeof templateShape> = z.object(templateShape);
const templateListShape = {
  /** 当前页各模板的最新版本。 */
  items: z.array(personaTemplateSchema).max(100),
  /** 下一页 UUID 游标。 */
  nextAfterId: uuidSchema.nullable(),
};
/** 模板分页列表。 */
export const personaTemplateListSchema: z.ZodObject<typeof templateListShape> =
  z.object(templateListShape);
/** 创建模板请求。 */
export type CreatePersonaTemplate = z.infer<typeof createPersonaTemplateSchema>;
/** 模板的不可变版本。 */
export type PersonaTemplate = z.infer<typeof personaTemplateSchema>;
/** 模板分页结果。 */
export type PersonaTemplateList = z.infer<typeof personaTemplateListSchema>;
