import { z } from 'zod';
import {
  idPaginationQueryShape,
  positiveIntegerSchema,
  runtimeEpochQuerySchema,
  utcDateTimeSchema,
  uuidSchema,
} from './common';
import { taskStatusSchema } from './tasks';

const memoryConfigurationShape = {
  /** 是否自动整理；关闭后仍可显式安排一个批次。 */
  enabled: z.boolean().default(true),
  /** 最后一次发布后的空闲毫秒数。 */
  idleMs: z.number().int().min(1000).max(3600000).default(30000),
  /** 最早待整理消息的最长等待毫秒数。 */
  maxWaitMs: z.number().int().min(1000).max(86400000).default(300000),
  /** 达到此消息数量即安排批次。 */
  messageThreshold: z.number().int().min(1).max(40).default(16),
  /** 达到此原文字符数即安排批次。 */
  characterThreshold: z.number().int().min(100).max(24000).default(12000),
  /** 单个批次最多处理的完整消息数，不截断原文。 */
  maxMessages: z.number().int().min(1).max(40).default(24),
  /** 模型输入最大字符数；装不下单条时保留阻塞而非跳过。 */
  maxInputCharacters: z.number().int().min(2000).max(60000).default(24000),
  /** 同会话用于理解代词等的前置原文条数。 */
  contextMessages: z.number().int().min(0).max(10).default(4),
  /** 同会话提供给整理器的近期旧记忆上限。 */
  relatedMemories: z.number().int().min(0).max(30).default(12),
};
/** 部署集中配置；每个批次保存生效快照。 */
export const memoryConfigurationSchema: z.ZodObject<
  typeof memoryConfigurationShape,
  z.core.$strict
> = z.object(memoryConfigurationShape).strict();
export type MemoryConfiguration = z.infer<typeof memoryConfigurationSchema>;
const memoryQueryShape = {
  ...idPaginationQueryShape,
  /** 所属实例当前运行代次。 */
  runtimeEpoch: runtimeEpochQuerySchema,
  /** F08 按会话组织，避免跨私聊推断与越权。 */
  conversationId: uuidSchema,
};
/** 记忆与批次均使用稳定 UUID 分页。 */
export const memoryQuerySchema: z.ZodObject<typeof memoryQueryShape, z.core.$strict> = z
  .object(memoryQueryShape)
  .strict();
export type MemoryQuery = z.infer<typeof memoryQuerySchema>;
const organizeMemoryShape = {
  /** 命令身份，网络重试必须复用。 */
  requestId: uuidSchema,
  /** 不得自动替换的实例代次。 */
  runtimeEpoch: positiveIntegerSchema,
  /** 本次整理的共享会话。 */
  conversationId: uuidSchema,
};
/** 提前唤醒一个批次，不是逐条记忆的人工审批。 */
export const organizeMemorySchema: z.ZodObject<typeof organizeMemoryShape, z.core.$strict> = z
  .object(organizeMemoryShape)
  .strict();
export type OrganizeMemory = z.infer<typeof organizeMemorySchema>;
const memoryBatchResultShape = {
  /** 已固定的批次身份。 */
  id: uuidSchema,
  /** 后台任务；空批次没有模型任务。 */
  taskId: uuidSchema.nullable(),
  /** 本批确切原文数量，不包含前置上下文。 */
  sourceCount: z.number().int().nonnegative(),
};
export const memoryBatchResultSchema: z.ZodObject<typeof memoryBatchResultShape> =
  z.object(memoryBatchResultShape);
export type MemoryBatchResult = z.infer<typeof memoryBatchResultSchema>;
const memoryBatchShape = {
  ...memoryBatchResultShape,
  /** 持久任务状态，成功表示结果与范围一起提交。 */
  status: taskStatusSchema,
  /** 受控阻塞或失败原因，不包含私有正文。 */
  reason: z.string().nullable(),
  /** 原文确切序号；不能将最大值当成所有历史均已完成。 */
  sequences: z.array(positiveIntegerSchema),
  /** 实际生效的模型配置版本。 */
  configVersion: positiveIntegerSchema,
  /** 测试模式不会模拟真实提取质量。 */
  mode: z.enum(['test', 'model']),
  /** 五类结果数量，尚未提交时为空。 */
  outcomes: z
    .object({
      add: z.number().int(),
      merge: z.number().int(),
      revise: z.number().int(),
      conflict: z.number().int(),
      defer: z.number().int(),
    })
    .nullable(),
  /** 批次创建时间。 */
  createdAt: utcDateTimeSchema,
  /** 批次关闭时间；是否采用结果由任务状态与 outcomes 判断。 */
  completedAt: utcDateTimeSchema.nullable(),
};
export const memoryBatchSchema: z.ZodObject<typeof memoryBatchShape> = z.object(memoryBatchShape);
export type MemoryBatch = z.infer<typeof memoryBatchSchema>;
/** 批次分页和当前部署参数，失败不影响后续聊天原文保存。 */
export const memoryBatchListSchema = z.object({
  items: z.array(memoryBatchSchema),
  nextAfterId: uuidSchema.nullable(),
  configuration: memoryConfigurationSchema,
});
export type MemoryBatchList = z.infer<typeof memoryBatchListSchema>;

const memoryDocumentShape = {
  /** 逻辑记忆用途；反思及人格成长由后续模块负责。 */
  kind: z.enum(['semantic', 'episodic', 'relational', 'procedural', 'narrative']),
  /** 短暂状态与稳定偏好分开，不能因一次情绪改写人格。 */
  claim: z.enum([
    'fact',
    'preference',
    'state',
    'experience',
    'interaction',
    'commitment',
    'unfinished',
    'creative_setting',
  ]),
  /** 对象无法确定时使用 unknown，不能猜成用户。 */
  subject: z
    .object({
      kind: z.enum(['user', 'self', 'other', 'unknown']),
      name: z.string().min(1).max(120).nullable(),
    })
    .strict(),
  /** 提炼后的主张，原文另存且不被覆盖。 */
  text: z.string().min(1).max(1200),
  /** 虚构设定不进入现实事实。 */
  reality: z.enum(['real', 'fictional', 'unspecified']),
  /** 虚构故事的独立名称/版本，现实记忆为空。 */
  storyKey: z.string().min(1).max(120).nullable(),
  /** 陈述、转述、推测和创作设定的认识来源。 */
  epistemic: z.enum(['statement', 'report', 'inference', 'setting']),
  /** 保留原文时间精度，如“昨天”或“2026 年”；未知为空。 */
  eventTime: z.string().min(1).max(120).nullable(),
  /** 主张开始适用的时间描述，不以入库时间代替。 */
  validFrom: z.string().min(1).max(120).nullable(),
  /** 结束适用的时间描述；未知为空，不推算具体日期。 */
  validUntil: z.string().min(1).max(120).nullable(),
};
/** 可移植的语义正文，模型只能提出候选。 */
export const memoryDocumentSchema: z.ZodObject<typeof memoryDocumentShape, z.core.$strict> = z
  .object(memoryDocumentShape)
  .strict();
export type MemoryDocument = z.infer<typeof memoryDocumentSchema>;
const memoryItemShape = {
  /** 稳定记忆身份，修订不换 ID。 */
  id: uuidSchema,
  /** 当前正文版本，重复证据不增加语义版本。 */
  version: positiveIntegerSchema,
  /** 当前版本身份，用于历史与来源回查。 */
  versionId: uuidSchema,
  /** disputed 表示仍需保留各方主张，不能当作唯一事实。 */
  status: z.enum(['active', 'disputed', 'invalidated']),
  /** 删除依赖后为空，不回退成一个可能已经过期的旧事实。 */
  document: memoryDocumentSchema.nullable(),
  /** 首次形成此版本的时间，与经历时间区分。 */
  learnedAt: utcDateTimeSchema,
  /** 测试结果和真实模型结果明确区分。 */
  mode: z.enum(['test', 'model']),
};
export const memoryItemSchema: z.ZodObject<typeof memoryItemShape> = z.object(memoryItemShape);
export type MemoryItem = z.infer<typeof memoryItemSchema>;
/** 当前记忆分页，不自动认定发生过反思或人格更新。 */
export const memoryListSchema = z.object({
  items: z.array(memoryItemSchema),
  nextAfterId: uuidSchema.nullable(),
});
export type MemoryList = z.infer<typeof memoryListSchema>;
const memoryEvidenceShape = {
  /** 只指向已发布原文，不能引用模型虚构的身份。 */
  messageId: uuidSchema,
  /** 本次引用的确切内容版本。 */
  contentVersion: positiveIntegerSchema,
  /** JavaScript UTF-16 字符偏移，左闭右开。 */
  startOffset: z.number().int().nonnegative(),
  /** 引用结束偏移。 */
  endOffset: z.number().int().nonnegative(),
  /** 读取时从有效原文取出，不另存一份可能漏删的正文。 */
  quote: z.string(),
};
export const memoryEvidenceSchema: z.ZodObject<typeof memoryEvidenceShape> =
  z.object(memoryEvidenceShape);
const memoryVersionShape = {
  ...memoryItemShape,
  /** 形成原因，change 保留旧时事实，correction 指出旧主张错误。 */
  operation: z.enum(['add', 'merge', 'change', 'correction', 'conflict']),
  /** 被修订或提出分歧的旧版本，不覆盖其历史正文。 */
  previousVersionId: uuidSchema.nullable(),
  /** 整理器给出的有来源依据的理由，删除后为空。 */
  reason: z.string().nullable(),
  /** 精确证据，不将转述次数当作独立佐证数量。 */
  evidence: z.array(memoryEvidenceSchema),
  /** 精确证据独立分页，避免重复表达后一次读取全部历史。 */
  evidenceNextAfterId: uuidSchema.nullable(),
};
export const memoryVersionSchema: z.ZodObject<typeof memoryVersionShape> =
  z.object(memoryVersionShape);
export type MemoryVersion = z.infer<typeof memoryVersionSchema>;
/** 历史版本分页。 */
export const memoryDetailSchema = z.object({
  current: memoryItemSchema,
  versions: z.array(memoryVersionSchema),
  nextAfterId: uuidSchema.nullable(),
});
export type MemoryDetail = z.infer<typeof memoryDetailSchema>;

/** 一个语义版本的精确证据分页。 */
export const memoryEvidencePageSchema = z.object({
  items: z.array(memoryEvidenceSchema),
  nextAfterId: uuidSchema.nullable(),
});
export type MemoryEvidencePage = z.infer<typeof memoryEvidencePageSchema>;
