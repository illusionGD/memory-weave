import { z } from 'zod';
import { runtimeEpochQuerySchema, uuidSchema, utcDateTimeSchema, pageLimitSchema } from './common';
import { memoryItemSchema, memoryDocumentSchema } from './memories';

/** 后台浏览的集中上限；客户端与服务端共同使用，不是全量数据规模。 */
export const MEMORY_EXPLORER_LIMITS = {
  pageSize: 20,
  maxPageSize: 50,
  graphPageSize: 20,
  maxGraphEdges: 48,
  maxGraphNodes: 50,
  maxCanvasNodes: 200,
  maxCanvasEdges: 400,
  pollMs: 3000,
  maxReadReferences: 300,
} as const;

const explorerScopeShape = {
  /** 当前人生代次，服务端不自动换成新代次。 */
  runtimeEpoch: runtimeEpochQuerySchema,
  /** 省略时仅合并本用户与本伴侣的私聊；指定时只查该会话。 */
  conversationId: uuidSchema.optional(),
};
/** 记忆浏览范围，不扩展伴侣对其他人的私聊权限。 */
export const memoryExplorerScopeSchema: z.ZodObject<typeof explorerScopeShape, z.core.$strict> = z
  .object(explorerScopeShape)
  .strict();
export type MemoryExplorerScope = z.infer<typeof memoryExplorerScopeSchema>;
const explorerQueryShape = {
  ...explorerScopeShape,
  /** 对当前视图各版本的正文进行字面匹配，不调用模型或向量检索。 */
  q: z.string().trim().min(1).max(120).optional(),
  /** 按记忆用途筛选。 */
  kind: memoryDocumentSchema.shape.kind.optional(),
  /** 按主张类别筛选，如事实、偏好或创作设定。 */
  claim: memoryDocumentSchema.shape.claim.optional(),
  /** 版本可用状态；历史版本不沿用当前头的分歧状态。 */
  status: memoryItemSchema.shape.status.optional(),
  /** 现实、虚构和未明确的范围分别展示。 */
  reality: memoryDocumentSchema.shape.reality.optional(),
  /** 精确故事标识，不自动与同名现实对象合并。 */
  storyKey: z.string().trim().min(1).max(120).optional(),
  /** 记下时间的下界，含边界，以 UTC 传输。 */
  from: utcDateTimeSchema.optional(),
  /** 记下时间的上界，含边界，与经历时间无关。 */
  until: utcDateTimeSchema.optional(),
  /** 服务端返回的不透明分页游标，变更筛选后重新开始。 */
  cursor: z.string().min(1).max(2048).optional(),
  /** 每页最多五十条，默认二十条。 */
  limit: pageLimitSchema.pipe(z.number().max(MEMORY_EXPLORER_LIMITS.maxPageSize)),
};
/** 独立后台查询，不改变已有会话记忆接口。 */
export const memoryExplorerQuerySchema: z.ZodObject<typeof explorerQueryShape, z.core.$strict> = z
  .object(explorerQueryShape)
  .strict()
  .refine((query) => !query.from || !query.until || new Date(query.from) <= new Date(query.until), {
    message: '开始时间不能晚于结束时间。',
    path: ['until'],
  });
export type MemoryExplorerQuery = z.infer<typeof memoryExplorerQuerySchema>;
const explorerItemShape = {
  ...memoryItemSchema.shape,
  /** 该版本、当前头与来源可见状态的指纹，仅用于清除旧画面，不授予权限。 */
  readStamp: z.string().length(64),
  /** 形成该记忆的会话，用于继续查询版本与证据。 */
  conversationId: uuidSchema,
  /** 会话当前标题，不作为稳定身份。 */
  conversationTitle: z.string(),
  /** 是否仍是该记忆的当前版本；历史记录不可冒充当前事实。 */
  isCurrent: z.boolean(),
  /** 实际记录的形成方式，变化与纠错分开。 */
  operation: z.enum(['add', 'merge', 'change', 'correction', 'conflict']),
  /** 直接修订的旧版本，普通上下文依赖不冒充修订。 */
  previousVersionId: uuidSchema.nullable(),
  /** 有来源的整理说明；失效后为空。 */
  reason: z.string().nullable(),
};
/** 带来源会话的记忆版本展示记录。 */
export const memoryExplorerItemSchema: z.ZodObject<typeof explorerItemShape> =
  z.object(explorerItemShape);
export type MemoryExplorerItem = z.infer<typeof memoryExplorerItemSchema>;
const explorerPageShape = {
  /** 本页可见版本，不包含所有历史或总量推测。 */
  items: z.array(memoryExplorerItemSchema),
  /** 下一批游标，null 表示本轮时间上界内已读完。 */
  nextCursor: z.string().nullable(),
  /** 本轮浏览的创建时间上界，刷新后获取新记录。 */
  asOf: utcDateTimeSchema,
};
/** 有界记忆列表。 */
export const memoryExplorerPageSchema: z.ZodObject<typeof explorerPageShape> =
  z.object(explorerPageShape);
export type MemoryExplorerPage = z.infer<typeof memoryExplorerPageSchema>;

const graphQueryShape = {
  ...explorerScopeShape,
  /** 从逻辑记忆查看版本，或从某版本查看原文、修订和依赖。 */
  centerKind: z.enum(['memory', 'version']),
  /** 中心节点的稳定 UUID，不接受显示名或文字作为身份。 */
  centerId: uuidSchema,
  /** 同一中心后续邻接分页；换中心必须清空游标。 */
  cursor: z.string().min(1).max(2048).optional(),
  /** 每次最多四十八条关系，连同中心及所属记忆最多五十个节点。 */
  limit: pageLimitSchema.pipe(z.number().max(MEMORY_EXPLORER_LIMITS.maxGraphEdges)),
};
/** 图谱只按中心展开，不加载全部历史。 */
export const memoryGraphQuerySchema: z.ZodObject<typeof graphQueryShape, z.core.$strict> = z
  .object(graphQueryShape)
  .strict();
export type MemoryGraphQuery = z.infer<typeof memoryGraphQuerySchema>;
const graphNodeShape = {
  /** 带节点种类前缀的身份，用于客户端去重。 */
  id: z.string(),
  /** 记忆、版本或实际原文，不以相似度创造人物和事件。 */
  kind: z.enum(['memory', 'version', 'message']),
  /** 服务端生成的纯文本短标签。 */
  label: z.string(),
  /** 记忆/版本的可见记录；原文节点为空。 */
  record: memoryExplorerItemSchema.nullable(),
  /** 原文节点的确切消息身份，完整正文仍需回查。 */
  messageId: uuidSchema.nullable(),
  /** 原文内容版本；记忆/版本节点为空。 */
  contentVersion: z.number().int().positive().nullable(),
  /** 来源所属会话，不能由客户端任意替换。 */
  conversationId: uuidSchema,
};
/** 图谱节点的展示数据，不作为新的持久记忆。 */
export const memoryGraphNodeSchema: z.ZodObject<typeof graphNodeShape> = z.object(graphNodeShape);
export type MemoryGraphNode = z.infer<typeof memoryGraphNodeSchema>;
const graphEdgeShape = {
  /** 来自实际记录的稳定关系身份。 */
  id: z.string(),
  /** 关系起点的图谱节点身份。 */
  source: z.string(),
  /** 关系终点的图谱节点身份。 */
  target: z.string(),
  /** 引用/上下文、所属、修订与通用依赖的含义分别保留。 */
  kind: z.enum([
    'version',
    'quote',
    'context',
    'merge',
    'change',
    'correction',
    'conflict',
    'dependency',
  ]),
  /** 仅 quote 关系含有效原文的精确片段，其余为空。 */
  quote: z.string().nullable(),
};
/** 有记录的关系不等于内容已经得到事实核实。 */
export const memoryGraphEdgeSchema: z.ZodObject<typeof graphEdgeShape> = z.object(graphEdgeShape);
export type MemoryGraphEdge = z.infer<typeof memoryGraphEdgeSchema>;
const graphPageShape = {
  /** 本次展开的中心节点身份。 */
  center: z.string(),
  /** 当前批次的可见节点，最多五十个。 */
  nodes: z.array(memoryGraphNodeSchema),
  /** 当前批次的实际关系。 */
  edges: z.array(memoryGraphEdgeSchema),
  /** 同一中心剩余关系的继续游标。 */
  nextCursor: z.string().nullable(),
  /** 本次浏览的新版本时间上界，不绕过最新权限与删除检查。 */
  asOf: utcDateTimeSchema,
};
/** 有界局部图，不把当前画布当作全部关系。 */
export const memoryGraphPageSchema: z.ZodObject<typeof graphPageShape> = z.object(graphPageShape);
export type MemoryGraphPage = z.infer<typeof memoryGraphPageSchema>;

const readReferenceShape = {
  /** 画面正在展示或依赖的语义版本。 */
  versionId: uuidSchema,
  /** 读取时由服务端返回的可见状态指纹。 */
  stamp: z.string().length(64),
};
/** 客户端只核对已加载的有限记录，不扫描全部伴侣历史。 */
export const memoryReadReferenceSchema: z.ZodObject<typeof readReferenceShape, z.core.$strict> = z
  .object(readReferenceShape)
  .strict();
export type MemoryReadReference = z.infer<typeof memoryReadReferenceSchema>;
const validateShape = {
  ...explorerScopeShape,
  /** 去重后的画面依赖，包含列表、详情和图谱。 */
  references: z.array(memoryReadReferenceSchema).max(MEMORY_EXPLORER_LIMITS.maxReadReferences),
};
/** 只读校验使用 POST 容纳有界引用集，不改变已读或业务状态。 */
export const memoryExplorerValidationSchema: z.ZodObject<typeof validateShape, z.core.$strict> = z
  .object(validateShape)
  .strict();
export type MemoryExplorerValidation = z.infer<typeof memoryExplorerValidationSchema>;
/** false 时客户端必须清除旧内容，重新读取后才能继续展示。 */
const validationResultShape = {
  /** 引用的版本与可见状态是否仍一致；false 时必须清除旧正文。 */
  valid: z.boolean(),
};
export const memoryExplorerValidationResultSchema: z.ZodObject<typeof validationResultShape> =
  z.object(validationResultShape);
export type MemoryExplorerValidationResult = z.infer<typeof memoryExplorerValidationResultSchema>;

const conversationQueryShape = {
  /** 只列出该实例当前代次可见的会话。 */
  runtimeEpoch: runtimeEpochQuerySchema,
  /** 会话选择器的稳定分页身份。 */
  afterId: uuidSchema.optional(),
  /** 选择器每批最大五十个会话。 */
  limit: pageLimitSchema.pipe(z.number().max(MEMORY_EXPLORER_LIMITS.maxPageSize)),
};
export const memoryExplorerConversationsQuerySchema: z.ZodObject<
  typeof conversationQueryShape,
  z.core.$strict
> = z.object(conversationQueryShape).strict();
export type MemoryExplorerConversationsQuery = z.infer<
  typeof memoryExplorerConversationsQuerySchema
>;
const explorerConversationShape = {
  /** 用于缩小到单个会话的稳定身份。 */
  id: uuidSchema,
  /** 纯文本会话名称。 */
  title: z.string(),
  /** 群聊只能单独查看，不汇入默认私聊范围。 */
  kind: z.enum(['private', 'group']),
};
export const memoryExplorerConversationSchema: z.ZodObject<typeof explorerConversationShape> =
  z.object(explorerConversationShape);
export type MemoryExplorerConversation = z.infer<typeof memoryExplorerConversationSchema>;
const explorerConversationsShape = {
  /** 本页可选择的会话。 */
  items: z.array(memoryExplorerConversationSchema),
  /** 后续选择页，不能将当前页当成全部会话。 */
  nextAfterId: uuidSchema.nullable(),
};
export const memoryExplorerConversationsSchema: z.ZodObject<typeof explorerConversationsShape> =
  z.object(explorerConversationsShape);
export type MemoryExplorerConversations = z.infer<typeof memoryExplorerConversationsSchema>;
