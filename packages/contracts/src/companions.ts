import { avatarStateSchema } from './avatars';
import { z } from 'zod';
import { positiveIntegerSchema, utcDateTimeSchema, uuidSchema } from './common';
import { personaDocumentSchema } from './persona-document';

const createCompanionRequestShape = {
  /** 创建命令的 UUID 幂等键；同键同载荷重放，同键异载荷返回冲突。 */
  requestId: uuidSchema,
  /** 实例显示名称，去除首尾空白后为 1～80 个字符。 */
  name: z.string().trim().min(1).max(80),
  /** 创建时的人格原文，长度为 1～4000；本阶段不解析人格层级或自动成长。 */
  initialProfile: z.string().min(1).max(4000),
};

/** 创建实例请求；owner、初始代次和版本均由服务端生成。 */
export const createCompanionRequestSchema: z.ZodObject<
  typeof createCompanionRequestShape,
  z.core.$strict
> = z.object(createCompanionRequestShape).strict();

const initialSnapshotShape = {
  /** 创建时冻结的初始快照标识，与当前人格版本标识不同。 */
  id: uuidSchema,
  /** 初始快照的数据结构版本，当前固定为 1。 */
  schemaVersion: z.literal(1),
  /** 创建时的人格原文；后续当前人格变化不会覆盖此内容。 */
  profileText: z.string().min(1).max(4000),
  /** 快照来源固定为初始设定，不能将其冒充实例亲历。 */
  sourceKind: z.literal('initial_setting'),
  /** 快照首次创建的 UTC 时间。 */
  createdAt: utcDateTimeSchema,
};

/** 与当前人格版本分别保存的不可变初始快照。 */
export const initialSnapshotSchema: z.ZodObject<typeof initialSnapshotShape> =
  z.object(initialSnapshotShape);

const personaVersionShape = {
  /** 人格版本记录的稳定标识。 */
  id: uuidSchema,
  /** 所属部署的持久 owner 标识。 */
  ownerId: uuidSchema,
  /** 此人格版本所属的稳定实例标识。 */
  companionId: uuidSchema,
  /** 此人格版本所属的运行代次，与实例稳定标识分别记录。 */
  runtimeEpoch: positiveIntegerSchema,
  /** 此代次下不可变的人格版本号。 */
  version: positiveIntegerSchema,
  /** 版本对应的原稿；整理后以 document 为人格内容，原稿仅供溯源。 */
  profileText: z.string().min(1).max(4000),
  /** 整理后的人格文档；尚未整理的原稿版本为 null。 */
  document: personaDocumentSchema.nullable(),
  /** 版本产生原因，自动成长将独立扩展。 */
  origin: z.enum(['initial_text', 'initialization', 'lock_revision', 'reset']),
  /** 前一版记录标识；原稿首版为空。 */
  parentVersionId: uuidSchema.nullable(),
  /** 整理使用的模型调用；人工约束修订不产生新模型调用。 */
  modelCallId: uuidSchema.nullable(),
  /** 确定性测试或真实模型；未整理时为空。 */
  mode: z.enum(['test', 'model']).nullable(),
  /** 此人格版本创建的 UTC 时间。 */
  createdAt: utcDateTimeSchema,
};

/** 可被实例当前版本引用的人格记录。 */
export const personaVersionSchema: z.ZodObject<typeof personaVersionShape> =
  z.object(personaVersionShape);

const companionDetailShape = {
  ...avatarStateSchema.shape,
  /** 清理期间不能生成或修改；通过操作身份查看实际进度。 */
  lifecycleOperationId: uuidSchema.nullable().default(null),
  /** 实例的稳定标识；未来代次变化仍使用此标识。 */
  id: uuidSchema,
  /** 所属部署的持久 owner 标识，只由服务端决定。 */
  ownerId: uuidSchema,
  /** 实例显示名称，长度为 1～80。 */
  name: z.string().min(1).max(80),
  /** 实例当前运行代次，F02 创建时为 1。 */
  runtimeEpoch: positiveIntegerSchema,
  /** 实例元数据版本，与人格内容版本及运行代次独立。 */
  version: positiveIntegerSchema,
  /** 创建时冻结的初始快照，不能以当前人格版本覆盖。 */
  initialSnapshot: initialSnapshotSchema,
  /** 当前生效的人格版本记录标识。 */
  currentPersonaVersionId: uuidSchema,
  /** 当前人格版本详情；与 initialSnapshot 是不同记录。 */
  currentPersonaVersion: personaVersionSchema,
  /** 实例首次创建的 UTC 时间。 */
  createdAt: utcDateTimeSchema,
};

/** 已认证部署管理者可查看的实例详情。 */
export const companionDetailSchema: z.ZodObject<typeof companionDetailShape> =
  z.object(companionDetailShape);

const companionListResponseShape = {
  /** 当前页实例，按稳定 UUID 排序。 */
  items: z.array(companionDetailSchema).max(100),
  /** 下一页的 UUID 起点；没有更多实例时为 null。 */
  nextAfterId: uuidSchema.nullable(),
};

/** 实例列表响应，不向调用方暴露数据库行或幂等指纹。 */
export const companionListResponseSchema: z.ZodObject<typeof companionListResponseShape> = z.object(
  companionListResponseShape,
);

/** 创建实例请求。 */
export type CreateCompanionRequest = z.infer<typeof createCompanionRequestSchema>;
/** 不可变初始快照。 */
export type InitialSnapshot = z.infer<typeof initialSnapshotSchema>;
/** 当前或历史人格版本。 */
export type PersonaVersion = z.infer<typeof personaVersionSchema>;
/** 实例详情。 */
export type CompanionDetail = z.infer<typeof companionDetailSchema>;
/** 实例分页响应。 */
export type CompanionListResponse = z.infer<typeof companionListResponseSchema>;
