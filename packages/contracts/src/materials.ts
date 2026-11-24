import { z } from 'zod';
import { utcDateTimeSchema, uuidSchema } from './common';

/** 材料原件的可识别格式。 */
export const materialKindSchema = z.enum(['text', 'markdown', 'pdf', 'jpeg', 'png', 'webp', 'web']);
export type MaterialKind = z.infer<typeof materialKindSchema>;

/** 对话与材料查询共用的版本概况，仅返回可显示的字段。 */
export const materialSummarySchema = z.strictObject({
  id: uuidSchema,
  kind: materialKindSchema,
  title: z.string().max(512),
  state: z.enum(['pending', 'parsed', 'partial', 'unavailable']),
  reason: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  acquiredAt: utcDateTimeSchema.nullable(),
  byteLength: z.number().int().nonnegative(),
  partCount: z.number().int().nonnegative(),
});
export type MaterialSummary = z.infer<typeof materialSummarySchema>;

/** 原始文件上传参数，同键只接受同一份原件。 */
export const materialUploadSchema = z.strictObject({
  requestId: uuidSchema,
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[^/\\]+$/u),
  kind: materialKindSchema.exclude(['web']),
});
export type MaterialUpload = z.infer<typeof materialUploadSchema>;

/** 材料分片查询采用有序位置游标。 */
export const materialPartsQuerySchema = z.strictObject({
  after: z.coerce.number().int().min(0).max(2_147_483_647).default(0),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});
export type MaterialPartsQuery = z.infer<typeof materialPartsQuerySchema>;

export const materialRegionSchema = z.strictObject({
  left: z.number().int().nonnegative(),
  top: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export const materialPartSchema = z.strictObject({
  position: z.number().int().positive(),
  page: z.number().int().positive().nullable(),
  status: z.enum(['text', 'no-text-layer', 'image']),
  text: z.string().nullable(),
  region: materialRegionSchema.nullable(),
});
export type MaterialPart = z.infer<typeof materialPartSchema>;

export const materialPartsPageSchema = z.strictObject({
  items: z.array(materialPartSchema),
  nextAfter: z.number().int().positive().nullable(),
});
export type MaterialPartsPage = z.infer<typeof materialPartsPageSchema>;

/** 实际提交给聊天模型的有限文字范围。 */
export const materialContextSchema = z.strictObject({
  messageId: uuidSchema,
  contentVersion: z.number().int().positive(),
  materialId: uuidSchema,
  title: z.string(),
  state: materialSummarySchema.shape.state,
  reason: z.string().nullable(),
  totalParts: z.number().int().nonnegative(),
  requestedPage: z.number().int().positive().nullable(),
  /** 视觉结果属于观察，区域为空表示整图缩小后的概览。 */
  observation: z
    .strictObject({
      modelCallId: uuidSchema,
      description: z.string().max(1200),
      uncertainty: z.string().max(400),
      region: materialRegionSchema.nullable(),
    })
    .optional(),
  excerpts: z
    .array(
      z.strictObject({
        position: z.number().int().positive(),
        page: z.number().int().positive().nullable(),
        text: z.string().max(1800),
        truncated: z.boolean(),
      }),
    )
    .max(3),
});
export type MaterialContext = z.infer<typeof materialContextSchema>;

/** 全文文字总结以确切的已发布消息版本作为权限和溯源边界。 */
export const materialSummaryRequestSchema = z.strictObject({
  requestId: uuidSchema,
  messageId: uuidSchema,
  contentVersion: z.number().int().positive(),
});
export type MaterialSummaryRequest = z.infer<typeof materialSummaryRequestSchema>;

export const materialSummaryProgressSchema = z.strictObject({
  taskId: uuidSchema,
  state: z.enum([
    'queued',
    'running',
    'waiting',
    'paused',
    'blocked',
    'succeeded',
    'failed',
    'cancelled',
  ]),
  coveredParts: z.number().int().nonnegative(),
  totalParts: z.number().int().nonnegative(),
  partial: z.boolean(),
  reason: z.string().nullable(),
  batches: z.array(
    z.strictObject({
      positions: z.array(z.number().int().positive()),
      text: z.string(),
    }),
  ),
});
export type MaterialSummaryProgress = z.infer<typeof materialSummaryProgressSchema>;

/** 定位记忆依据的原件文字或图像观察。 */
export const materialEvidenceLocatorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('material-text'),
    materialId: uuidSchema,
    position: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal('image-observation'),
    materialId: uuidSchema,
    modelCallId: uuidSchema,
  }),
]);
export type MaterialEvidenceLocator = z.infer<typeof materialEvidenceLocatorSchema>;
