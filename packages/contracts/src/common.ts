import { z } from 'zod';

/** 服务端及请求中的稳定 UUID 标识。 */
export const uuidSchema = z.uuid();

/** 版本、代次及已发布序号使用的正整数，不得超过 PostgreSQL integer 的上限。 */
export const positiveIntegerSchema = z.number().int().positive().max(2_147_483_647);

/** 尚无消息时的序号及分页起点允许为零，不得超过 PostgreSQL integer 的上限。 */
export const nonnegativeIntegerSchema = z.number().int().nonnegative().max(2_147_483_647);

/** UTC ISO 时间字符串，必须使用 Z 时区，不接受本地时间或时区偏移。 */
export const utcDateTimeSchema = z.iso.datetime({ offset: false, local: false });

/** URL 查询整数只接受数字或十进制整数字符串，拒绝空值、布尔值及指数形式。 */
const queryIntegerSchema = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(nonnegativeIntegerSchema);

/** 分页条数默认为 20，每次最多 100 条。 */
export const pageLimitSchema = queryIntegerSchema.pipe(z.number().min(1).max(100)).default(20);

/** 按发布序号分页的起点，首次查询从零开始。 */
export const afterSequenceSchema = queryIntegerSchema.default(0);

/** 查询中的运行代次必须由调用方明确提供，不能补默认代次。 */
export const runtimeEpochQuerySchema = queryIntegerSchema.pipe(positiveIntegerSchema);

/** 查询中的内容版本必须是正整数，与消息保存修订号独立。 */
export const contentVersionQuerySchema = queryIntegerSchema.pipe(positiveIntegerSchema);

export const idPaginationQueryShape = {
  /** 上一页末尾的稳定 UUID；省略时查询第一页。 */
  afterId: uuidSchema.optional(),
  /** 本页最大条数，默认 20，范围为 1～100。 */
  limit: pageLimitSchema,
};

/** 实例与会话的稳定 UUID 游标分页请求。 */
export const idPaginationQuerySchema: z.ZodObject<typeof idPaginationQueryShape, z.core.$strict> = z
  .object(idPaginationQueryShape)
  .strict();

export const sequencePaginationQueryShape = {
  /** 仅返回大于此发布序号的条目；默认零，草稿没有发布序号。 */
  afterSequence: afterSequenceSchema,
  /** 本页最大条数，默认 20，范围为 1～100。 */
  limit: pageLimitSchema,
};

/** 已发布消息与逐条处理进度的序号分页请求。 */
export const sequencePaginationQuerySchema: z.ZodObject<
  typeof sequencePaginationQueryShape,
  z.core.$strict
> = z.object(sequencePaginationQueryShape).strict();

const companionSequenceQueryShape = {
  ...sequencePaginationQueryShape,
  /** 当前伴侣的预期运行代次；必须显式提供，服务端拒绝过时代次。 */
  runtimeEpoch: runtimeEpochQuerySchema,
};

/** 伴侣视角下的消息及进度分页请求，不代表已经取得消息正文。 */
export const companionSequenceQuerySchema: z.ZodObject<
  typeof companionSequenceQueryShape,
  z.core.$strict
> = z.object(companionSequenceQueryShape).strict();

const sourceLookupQueryShape = {
  /** 查询伴侣的预期运行代次，必须显式提供。 */
  runtimeEpoch: runtimeEpochQuerySchema,
  /** 待回查原文的确切内容版本；不接受消息保存修订号替代。 */
  contentVersion: contentVersionQuerySchema,
};

/** 伴侣按消息标识和内容版本回查来源的查询参数。 */
export const sourceLookupQuerySchema: z.ZodObject<typeof sourceLookupQueryShape, z.core.$strict> = z
  .object(sourceLookupQueryShape)
  .strict();

const workspaceResponseShape = {
  /** 当前部署的持久 owner 标识，只能由服务端确定，不能由写入请求指定。 */
  ownerId: uuidSchema,
  /** 工作区公共结构版本，当前固定为 1。 */
  schemaVersion: z.literal(1),
};

/** 当前已认证管理者所属部署的工作区信息。 */
export const workspaceResponseSchema: z.ZodObject<typeof workspaceResponseShape> =
  z.object(workspaceResponseShape);

/** UUID 游标分页参数。 */
export type IdPaginationQuery = z.infer<typeof idPaginationQuerySchema>;
/** 已发布序号分页参数。 */
export type SequencePaginationQuery = z.infer<typeof sequencePaginationQuerySchema>;
/** 伴侣视角下的分页参数。 */
export type CompanionSequenceQuery = z.infer<typeof companionSequenceQuerySchema>;
/** 原文来源回查参数。 */
export type SourceLookupQuery = z.infer<typeof sourceLookupQuerySchema>;
/** 当前部署工作区响应。 */
export type WorkspaceResponse = z.infer<typeof workspaceResponseSchema>;
