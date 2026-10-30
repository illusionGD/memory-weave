import { z } from 'zod';
import { positiveIntegerSchema, utcDateTimeSchema, uuidSchema } from './common';
import { memoryDocumentSchema } from './memories';

/** 检索请求不要求问句；同一请求身份用于外部向量调用去重。 */
export const recallQuerySchema = z
  .object({
    /** 一次检索身份，重试沿用。 */
    requestId: uuidSchema,
    /** 当前伴侣运行代次。 */
    runtimeEpoch: positiveIntegerSchema,
    /** 结果拟使用的会话，不能借检索扩大分享范围。 */
    conversationId: uuidSchema,
    /** 原始输入及必要前文；不自动改写成新增事实。 */
    query: z.string().trim().min(1).max(4000),
    /** 用于指代的有限前文，与原始输入分开保存，不补造实体。 */
    context: z.string().max(2000).default(''),
    /** 显式对象条件；未提供时不由程序猜测。 */
    subject: z.enum(['user', 'self', 'other', 'unknown']).optional(),
    /** 显式人物或对象名称。 */
    subjectName: z.string().min(1).max(120).optional(),
    /** ordinary 查询当前事实；history 保留旧版本并明确标识。 */
    mode: z.enum(['ordinary', 'history']).default('ordinary'),
    /** 已知身份时直接定位，仍检查全部来源。 */
    memoryId: uuidSchema.optional(),
    /** 默认查询现实及未定范围；创作须显式选择故事。 */
    reality: z.enum(['real', 'fictional']).default('real'),
    /** 创作故事名称；不会自动从现实词语推断。 */
    storyKey: z.string().min(1).max(120).optional(),
  })
  .strict();
export type RecallQuery = z.infer<typeof recallQuerySchema>;

/** 实例有权取得的确切新原文，接收时间不等于事实生效时间。 */
export const recallSourceSchema = z.object({
  /** 来源会话。 */
  conversationId: uuidSchema,
  /** 精确原文身份。 */
  messageId: uuidSchema,
  /** 原文版本。 */
  contentVersion: positiveIntegerSchema,
  /** 所属会话发布顺序，不能跨会话比较。 */
  sequence: positiveIntegerSchema,
  /** 完整正文，不静默截断后声称已经读完。 */
  text: z.string(),
  /** 原始来源类型。 */
  sourceKind: z.string(),
  /** 陈述与创作分别保留。 */
  reality: z.string(),
  /** 当前实际发言身份。 */
  speaker: z.enum(['user', 'companion']),
  /** 实际取得此版本时核对的权限版本。 */
  permissionVersion: positiveIntegerSchema,
  /** 系统收到原文的 UTC 时间。 */
  receivedAt: utcDateTimeSchema,
  /** 来源声明的发生时间，未知保留空值。 */
  occurredAt: utcDateTimeSchema.nullable(),
});
export type RecallSource = z.infer<typeof recallSourceSchema>;

/** 检索参数集中配置，各条通道均有界。 */
export const retrievalConfigurationSchema = z
  .object({
    /** 是否使用真实 embedding 与 Qdrant；test 编码默认跳过语义通道。 */
    vectorEnabled: z.boolean().default(true),
    /** 每次索引调度最多登记条数。 */
    indexBatchSize: z.number().int().min(1).max(20).default(4),
    /** Qdrant 单次请求超时，索引与检索共享。 */
    vectorTimeoutMs: z.number().int().min(100).max(10000).default(1500),
    /** 余弦相似度最低候选门槛；真实模型需用固定语料校准，不代表事实可信度。 */
    vectorMinScore: z.number().min(-1).max(1).default(0.3),
    /** 默认精确查询；ANN 需以部署语料验证召回率后显式启用。 */
    vectorSearchMode: z.enum(['exact', 'ann']).default('exact'),
    /** 最近未整理原文最多补读条数。 */
    pendingMessages: z.number().int().min(1).max(100).default(24),
    /** 完整原文补读字符预算。 */
    pendingCharacters: z.number().int().min(1000).max(24000).default(12000),
    /** 每路候选上限；历史查询最多两倍。 */
    candidates: z.number().int().min(5).max(100).default(30),
    /** 最多送入模型的记忆版本数。 */
    results: z.number().int().min(1).max(20).default(8),
    /** 记忆正文字符预算，原文补读另计。 */
    memoryCharacters: z.number().int().min(1000).max(16000).default(8000),
    /** 排名融合常数，不直接相加异构相似度。 */
    rrfK: z.number().int().min(1).max(100).default(60),
  })
  .strict();
export type RetrievalConfiguration = z.infer<typeof retrievalConfigurationSchema>;

/** 每条命中保留真实渠道、版本与时间语义。 */
export const recallMemorySchema = z.object({
  /** 稳定记忆标识。 */
  id: uuidSchema,
  /** 精确正文版本标识。 */
  versionId: uuidSchema,
  /** 语义版本序号。 */
  version: positiveIntegerSchema,
  /** 该认识最初形成的会话。 */
  conversationId: uuidSchema,
  /** 此版本是否为当前有效头；历史版本不当作当前事实。 */
  current: z.boolean(),
  /** 现实变化、纠错、分歧分别表达。 */
  operation: z.string(),
  /** 分歧必须保留为未定认识。 */
  status: z.enum(['active', 'disputed']),
  /** 已核对来源的正文。 */
  document: memoryDocumentSchema,
  /** 系统形成该认识的时间，不等于发生时间。 */
  learnedAt: utcDateTimeSchema,
  /** 命中渠道，不代表独立证据数量。 */
  channels: z.array(z.enum(['direct', 'lexical', 'vector', 'recent'])),
  /** 版本的有限精确引文，完整来源可分页回查。 */
  evidence: z.array(
    z.object({
      /** 引文所属的原文身份。 */
      messageId: uuidSchema,
      /** 被采用的确切原文版本。 */
      contentVersion: positiveIntegerSchema,
      /** 来源中的逐字片段，不冒充完整原文。 */
      quote: z.string(),
    }),
  ),
});
export type RecallMemory = z.infer<typeof recallMemorySchema>;

/** 不完整覆盖须传递给回复模型和终端，不能把缺失当成不存在。 */
export const recallResultSchema = z.object({
  /** 用于理解检索指代的前文片段身份；并不声称读过完整来源。 */
  querySources: z
    .array(
      z.object({
        /** 前文所属会话。 */
        conversationId: uuidSchema,
        /** 前文原文身份。 */
        messageId: uuidSchema,
        /** 实际查询时取得的内容版本。 */
        contentVersion: positiveIntegerSchema,
        /** 原文在所属会话中的发布顺序。 */
        sequence: positiveIntegerSchema,
        /** 当时核对的成员权限版本。 */
        permissionVersion: positiveIntegerSchema,
        /** 实际读取片段的起始字符偏移，包含该位置。 */
        startOffset: z.number().int().nonnegative(),
        /** 实际读取片段的结束字符偏移，不包含该位置。 */
        endOffset: z.number().int().positive(),
      }),
    )
    .max(3)
    .optional(),
  /** 经过去重、版本和权限核对的记忆。 */
  memories: z.array(recallMemorySchema),
  /** 待整理原文，按接收顺序排列。 */
  pending: z.array(recallSourceSchema),
  /** 各条通道的实际覆盖情况。 */
  coverage: z.object({
    /** 所有当前授权的待整理原文是否均已包含。 */
    pendingComplete: z.boolean(),
    /** 候选上限是否触及，不等于已经查遍历史。 */
    candidateLimitReached: z.boolean(),
    /** 向量通道实际状态；退化时依旧提供数据库候选。 */
    vector: z.enum(['disabled', 'test', 'ready', 'unavailable', 'unknown', 'building']),
  }),
});
export type RecallResult = z.infer<typeof recallResultSchema>;

/** 索引是可重建的派生数据，状态不替代记忆正文。 */
export const recallIndexListSchema = z.object({
  /** 当前 embedding 空间指纹，模型/版本/维度/预处理不同即不同。 */
  space: z.string(),
  /** 有界索引记录，旧空间可并存。 */
  items: z.array(
    z.object({
      /** 一份版本在指定空间的索引记录身份。 */
      id: uuidSchema,
      /** 对应的权威记忆正文版本。 */
      versionId: uuidSchema,
      /** 此记录实际使用的编码空间。 */
      space: z.string(),
      /** 供部署诊断及恢复使用的实际 collection 名称，不含凭据或正文。 */
      collection: z.string(),
      /** 待同步、已同步或已删除；任务失败原因另查任务详情。 */
      status: z.enum(['pending', 'indexed', 'deleted']),
      /** 当前负责同步的任务，重试会保留旧任务并更新此引用。 */
      taskId: uuidSchema,
      /** 最近一次同步成功的时间，尚未成功时为空。 */
      indexedAt: utcDateTimeSchema.nullable(),
    }),
  ),
  /** UUID 分页游标。 */
  nextAfterId: uuidSchema.nullable(),
});
export type RecallIndexList = z.infer<typeof recallIndexListSchema>;
