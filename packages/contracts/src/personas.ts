import { z } from 'zod';
import { positiveIntegerSchema, uuidSchema } from './common';
import { companionDetailSchema, personaVersionSchema } from './companions';
import { lockedFeaturesSchema } from './persona-templates';
import { taskSchema } from './tasks';

const templateReferenceShape = {
  /** 模板稳定标识。 */
  id: uuidSchema,
  /** 创建时明确选择的不可变版本。 */
  version: positiveIntegerSchema,
};
/** 创建实例使用的模板来源。 */
export const personaTemplateReferenceSchema: z.ZodObject<
  typeof templateReferenceShape,
  z.core.$strict
> = z.object(templateReferenceShape).strict();
const textSourceShape = {
  /** 直接提供一段人设。 */
  kind: z.literal('text'),
  /** 原始人设，完整保存且不会被模型输出覆盖。 */
  profileText: z
    .string()
    .min(1)
    .max(4000)
    .refine((text) => text.trim().length > 0),
  /** 可选的明确约束，无需逐字段确认人格。 */
  lockedFeatures: lockedFeaturesSchema.default([]),
};
const templateSourceShape = {
  /** 使用一个固定版本的模板。 */
  kind: z.literal('template'),
  /** 选择的模板与确切版本，不能默认为日后最新版本。 */
  template: personaTemplateReferenceSchema,
};
const creationShape = {
  /** 创建命令幂等键，网络重试沿用同一值。 */
  requestId: uuidSchema,
  /** 可选名称；未填写则由初始整理决定。 */
  name: z.string().trim().min(1).max(80).optional(),
  /** 原始人设或模板，两者只能选择其一。 */
  source: z.discriminatedUnion('kind', [
    z.object(textSourceShape).strict(),
    z.object(templateSourceShape).strict(),
  ]),
};
/** 一段人设创建伴侣并自动排入初始整理任务。 */
export const companionCreationSchema: z.ZodObject<typeof creationShape, z.core.$strict> = z
  .object(creationShape)
  .strict();
const stateShape = {
  /** 当前实例与当前人格。 */
  companion: companionDetailSchema,
  /** 首次整理成功的人格，后续修订不会覆盖；尚未完成为空。 */
  initialPersonaVersion: personaVersionSchema.nullable(),
  /** 初始整理的持久任务；F02 旧原稿尚未启用时为空。 */
  task: taskSchema.nullable(),
  /** 创建时使用的模板版本，直接输入时为空。 */
  template: personaTemplateReferenceSchema.nullable(),
};
/** 伴侣人格页面状态，允许刷新后继续观察后台任务。 */
export const companionPersonaStateSchema: z.ZodObject<typeof stateShape> = z.object(stateShape);
/** 自动创建请求。 */
export type CompanionCreation = z.infer<typeof companionCreationSchema>;
/** 伴侣人格与初始整理状态。 */
export type CompanionPersonaState = z.infer<typeof companionPersonaStateSchema>;

const reviseLocksShape = {
  /** 此次修订的幂等标识。 */
  requestId: uuidSchema,
  /** 当前实例代次，不能以旧页面覆盖新代次。 */
  runtimeEpoch: positiveIntegerSchema,
  /** 编辑时的人格版本号，冲突时重新读取。 */
  expectedPersonaVersion: positiveIntegerSchema,
  /** 修订后保留的全部约束；空数组表示管理者明确解除这些约束。 */
  lockedFeatures: z.array(z.string().trim().min(1).max(800)).max(40),
};
/** 管理者可选的约束管理，不是自动成长的审批步骤。 */
export const revisePersonaLocksSchema: z.ZodObject<typeof reviseLocksShape, z.core.$strict> = z
  .object(reviseLocksShape)
  .strict();
/** 约束修订请求。 */
export type RevisePersonaLocks = z.infer<typeof revisePersonaLocksSchema>;

const initializeShape = {
  /** 显式开始或重试的幂等标识，自动恢复仍使用原任务。 */
  requestId: uuidSchema,
  /** 当前实例代次。 */
  runtimeEpoch: positiveIntegerSchema,
  /** 当前仍未整理的原稿版本。 */
  expectedPersonaVersion: positiveIntegerSchema,
};
/** 旧原稿启用整理，或在已知失败/取消后主动重新尝试。 */
export const initializePersonaSchema: z.ZodObject<typeof initializeShape, z.core.$strict> = z
  .object(initializeShape)
  .strict();
/** 显式整理命令。 */
export type InitializePersona = z.infer<typeof initializePersonaSchema>;
