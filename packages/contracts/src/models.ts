import { z } from 'zod';
import { positiveIntegerSchema, utcDateTimeSchema, uuidSchema } from './common';

/** 各任务独立选择模型与预算；成长提案和追加验证不是同一次调用。 */
export const MODEL_TASK_ROLES = [
  'chat',
  'persona',
  'memory',
  'reflection',
  'growth',
  'growth_validation',
  'relationship',
  'retrieval',
  'embedding',
] as const;
/** 任务角色的稳定枚举。 */
export const modelTaskRoleSchema = z.enum(MODEL_TASK_ROLES);
/** 模型任务角色。 */
export type ModelTaskRole = z.infer<typeof modelTaskRoleSchema>;

const dailyBudgetShape = {
  /** UTC 自然日最多发出的请求数；每次重试单独计数，零表示禁止。 */
  requests: z.number().int().min(0).max(1_000_000),
  /** UTC 自然日输入和输出 token 总额度；包含尚未结算的预留。 */
  tokens: z.number().int().min(0).max(1_000_000_000),
  /** UTC 自然日费用上限，单位为百万分之一美元；按配置价格估算。 */
  costMicros: z.number().int().min(0).max(1_000_000_000_000),
};
/** 全局与任务共用的每日额度，计数独立于配置版本保存。 */
export const dailyModelBudgetSchema: z.ZodObject<typeof dailyBudgetShape, z.core.$strict> = z
  .object(dailyBudgetShape)
  .strict();
/** 每日模型额度。 */
export type DailyModelBudget = z.infer<typeof dailyModelBudgetSchema>;

const modelTaskConfigShape = {
  /** 是否允许此任务发起新调用；关闭不撤销已发出的请求。 */
  enabled: z.boolean(),
  /** 部署登记的供应商标识；不能通过配置接口提交 URL 或密钥。 */
  providerId: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/),
  /** 供应商实际接受的模型名称，推荐固定版本。 */
  model: z.string().trim().min(1).max(120),
  /** 提示词或任务定义版本；实际提示词由调用模块提供。 */
  promptVersion: z.string().min(1).max(80),
  /** 输入处理版本，影响上下文构建及编码兼容性。 */
  preprocessingVersion: z.string().min(1).max(80),
  /** 调用模块注册的输出规范版本，不能代替实际校验。 */
  schemaVersion: z.string().min(1).max(80),
  /** 单次输入 token 预估上限；当前使用保守的 UTF-8 字节数加协议余量。 */
  maxInputTokens: z.number().int().min(128).max(131_072),
  /** 单次输出 token 上限；embedding 为零。 */
  maxOutputTokens: z.number().int().min(0).max(16_384),
  /** 每次外部尝试的超时，单位毫秒。 */
  timeoutMs: z.number().int().min(100).max(120_000),
  /** 包含首次请求的最多尝试次数；只重试明确的暂时错误。 */
  maxAttempts: z.number().int().min(1).max(3),
  /** 两次尝试之间的等待，单位毫秒；等待期间仍可取消。 */
  retryDelayMs: z.number().int().min(100).max(5000),
  /** 生成温度；null 表示不发送该参数，以适配不支持温度的模型。 */
  temperature: z.number().min(0).max(2).nullable(),
  /** 向量维度；非 embedding 任务为 null。 */
  dimensions: z.number().int().min(1).max(4096).nullable(),
  /** 每百万输入 token 的微美元价格；null 表示尚未配置，禁止真实调用。 */
  inputMicrosPerMillion: z.number().int().min(0).max(1_000_000_000).nullable(),
  /** 每百万输出 token 的微美元价格；允许显式零价表示本地服务。 */
  outputMicrosPerMillion: z.number().int().min(0).max(1_000_000_000).nullable(),
  /** 当前任务每日额度，仍同时受全局额度限制。 */
  dailyBudget: dailyModelBudgetSchema,
};
/** 单个任务的完整配置；各任务不会因共用供应商而一起切换。 */
export const modelTaskConfigSchema: z.ZodObject<typeof modelTaskConfigShape, z.core.$strict> = z
  .object(modelTaskConfigShape)
  .strict();
/** 模型任务配置。 */
export type ModelTaskConfig = z.infer<typeof modelTaskConfigSchema>;

const modelConfigurationShape = {
  /** 当前费用统一以美元计量，不把不同币种直接累加。 */
  currency: z.literal('USD'),
  /** 固定 UTC 日窗口，展示时区变化不会产生新额度。 */
  window: z.literal('utc_day'),
  /** 部署内所有任务共同遵守的额度。 */
  dailyBudget: dailyModelBudgetSchema,
  /** 同时执行的请求上限；预留和未知请求的处理见调用诊断。 */
  maxConcurrent: z.number().int().min(1).max(16),
  /** 后台请求并发上限；零可暂停后台，仍保留前台入口。 */
  backgroundConcurrent: z.number().int().min(0).max(8),
  /** 所有任务的独立完整配置；不允许省略某个任务或隐式继承其他任务。 */
  tasks: z.record(modelTaskRoleSchema, modelTaskConfigSchema),
};
/** 统一配置文档；跨字段与部署上限由服务端继续校验。 */
export const modelConfigurationSchema: z.ZodObject<typeof modelConfigurationShape, z.core.$strict> =
  z.object(modelConfigurationShape).strict();
/** 集中模型配置。 */
export type ModelConfiguration = z.infer<typeof modelConfigurationSchema>;

const modelConfigurationVersionShape = {
  /** 不可变配置版本的稳定标识。 */
  id: uuidSchema,
  /** 此部署内递增版本号。 */
  version: positiveIntegerSchema,
  /** 首次默认配置或部署者明确发布的配置。 */
  source: z.enum(['default', 'deployment']),
  /** 完整配置快照，不包含凭据。 */
  config: modelConfigurationSchema,
  /** 此版本的评估或变更说明；不意味着系统自动完成了语义评估。 */
  evaluationNote: z.string().max(500),
  /** 此配置版本创建时间。 */
  createdAt: utcDateTimeSchema,
};
/** 可回查的配置版本与来源。 */
export const modelConfigurationVersionSchema: z.ZodObject<typeof modelConfigurationVersionShape> =
  z.object(modelConfigurationVersionShape);
/** 配置版本响应。 */
export type ModelConfigurationVersion = z.infer<typeof modelConfigurationVersionSchema>;

const updateModelConfigurationShape = {
  /** 配置发布幂等键；重放不再次增加版本。 */
  requestId: uuidSchema,
  /** 必须等于当前生效版本，避免覆盖其他终端的修改。 */
  expectedVersion: positiveIntegerSchema,
  /** 经完整校验后一次切换的配置。 */
  config: modelConfigurationSchema,
  /** 本次评估或变更依据，修改任务配置时用于追溯。 */
  evaluationNote: z.string().trim().min(1).max(500),
};
/** 发布完整配置；回滚需读取旧版本并按新版本发布，不重置计数。 */
export const updateModelConfigurationSchema: z.ZodObject<
  typeof updateModelConfigurationShape,
  z.core.$strict
> = z.object(updateModelConfigurationShape).strict();
/** 发布配置的命令。 */
export type UpdateModelConfiguration = z.infer<typeof updateModelConfigurationSchema>;

/** 本阶段声明支持非流式文本、固定诊断结构和向量编码。 */
export const modelOperationSchema = z.enum(['text', 'structured', 'embedding']);
/** 模型调用类别。 */
export type ModelOperation = z.infer<typeof modelOperationSchema>;

const modelProbeShape = {
  /** 逻辑调用的 UUID 幂等键；重复请求不会自动补发外部调用。 */
  requestId: uuidSchema,
  /** 调用方已读取的有效配置版本；新调用拒绝过期版本。 */
  expectedConfigVersion: positiveIntegerSchema,
  /** 本次使用的独立任务配置与预算。 */
  role: modelTaskRoleSchema,
  /** 诊断操作，不生成或发布业务消息。 */
  operation: modelOperationSchema,
  /** 本次诊断输入，最多 4000 字符；不写入诊断日志或调用表。 */
  inputText: z.string().min(1).max(4000),
  /** 交互或后台优先级；后台并发另有限制。 */
  lane: z.enum(['interactive', 'background']).default('interactive'),
};
/** 部署管理者的隔离诊断调用，不接受任意 URL、密钥或自定义输出 schema。 */
export const modelProbeSchema: z.ZodObject<typeof modelProbeShape, z.core.$strict> = z
  .object(modelProbeShape)
  .strict();
/** 模型诊断命令。 */
export type ModelProbe = z.infer<typeof modelProbeSchema>;

const diagnosticValueShape = {
  /** 固定诊断的完成标志，业务功能须使用自己的输出校验。 */
  ok: z.boolean(),
  /** 模型给出的诊断文字，长度为 1～4000。 */
  reply: z.string().min(1).max(4000),
};
/** 固定诊断的严格结构；JSON 语法正确不代表通过此校验。 */
export const modelDiagnosticValueSchema: z.ZodObject<typeof diagnosticValueShape, z.core.$strict> =
  z.object(diagnosticValueShape).strict();

/** 仅返回通过相应输出检查的结果；向量不写入 Qdrant。 */
export const modelResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      /** 纯文本输出。 */ kind: z.literal('text'),
      /** 已完成且非截断的文本。 */ text: z.string().min(1).max(16_384),
    })
    .strict(),
  z
    .object({
      /** 通过任务规范校验的结构化结果。 */ kind: z.literal('structured'),
      /** 按 context.schemaVersion 校验的 JSON；诊断使用固定 ok/reply 结构。 */ value: z.json(),
    })
    .strict(),
  z
    .object({
      /** 独立向量编码结果。 */ kind: z.literal('embedding'),
      /** 长度须等于实际配置维度且只含有限数值。 */ vector: z.array(z.number()).min(1).max(4096),
    })
    .strict(),
]);
/** 模型诊断结果。 */
export type ModelResult = z.infer<typeof modelResultSchema>;

/** 调用或实际尝试的可观察状态；unknown 不得冒充成功，也不自动补发。 */
export const modelCallStatusSchema = z.enum([
  'running',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
]);
/** 模型调用状态。 */
export type ModelCallStatus = z.infer<typeof modelCallStatusSchema>;

const modelCallContextShape = {
  /** 诊断试跑或领域模块调用；均不代表业务状态已采用结果。 */
  kind: z.enum(['diagnostic', 'task']),
  /** 实际提示词版本，诊断使用自身版本。 */
  promptVersion: z.string().min(1).max(80),
  /** 实际输出校验版本。 */
  schemaVersion: z.string().min(1).max(80),
  /** 实际输入处理版本。 */
  preprocessingVersion: z.string().min(1).max(80),
  /** 关联实例；部署诊断为 null。 */
  companionId: uuidSchema.nullable(),
  /** 关联实例的预期代次，与稳定 ID 分开。 */
  runtimeEpoch: positiveIntegerSchema.nullable(),
  /** 关联会话；无会话来源时为 null。 */
  conversationId: uuidSchema.nullable(),
};
/** 模型调用的实际任务规范与业务范围，不包含原文输入。 */
export const modelCallContextSchema: z.ZodObject<typeof modelCallContextShape> =
  z.object(modelCallContextShape);
/** 模型调用任务与范围记录。 */
export type ModelCallContext = z.infer<typeof modelCallContextSchema>;

const modelAttemptShape = {
  /** 实际尝试的独立标识，与逻辑调用不同。 */
  id: uuidSchema,
  /** 当前逻辑调用内的尝试序号，从一开始。 */
  number: positiveIntegerSchema,
  /** 本次实际尝试的状态。 */
  status: modelCallStatusSchema,
  /** reported 为供应商上报；reserved 表示用量未知而保留预留。 */
  usageSource: z.enum(['reported', 'reserved']),
  /** 供应商上报的输入 token；未知为 null。 */
  inputTokens: z.number().int().nonnegative().nullable(),
  /** 供应商上报的输出 token；未知为 null。 */
  outputTokens: z.number().int().nonnegative().nullable(),
  /** 实际计入额度的 token，可能为尚未释放的保守预留。 */
  chargedTokens: z.number().int().nonnegative(),
  /** 按配置价格计算的微美元额度占用，不等于供应商账单。 */
  chargedCostMicros: z.number().int().nonnegative(),
  /** 受控失败分类，不包含供应商原始错误或输入。 */
  errorCode: z.number().int().nullable(),
  /** 实际响应中的模型名称；未知为 null。 */
  actualModel: z.string().max(160).nullable(),
  /** 供应商响应标识的 SHA-256 指纹，避免原始字段泄露信息。 */
  responseFingerprint: z.string().length(64).nullable(),
  /** 开始预留并准备发送的 UTC 时间。 */
  startedAt: utcDateTimeSchema,
  /** 本次尝试的到期时间；过期查询转为未知并保留额度。 */
  deadlineAt: utcDateTimeSchema,
  /** 结算或结束时间，进行中为 null。 */
  finishedAt: utcDateTimeSchema.nullable(),
};
/** 每一次实际请求的持久诊断。 */
export const modelAttemptSchema: z.ZodObject<typeof modelAttemptShape> =
  z.object(modelAttemptShape);
/** 实际请求的诊断记录。 */
export type ModelAttempt = z.infer<typeof modelAttemptSchema>;

const modelCallShape = {
  /** 实际采用的任务定义版本和作用范围。 */
  context: modelCallContextSchema,
  /** 逻辑调用稳定标识。 */
  id: uuidSchema,
  /** 调用方提供的幂等键。 */
  requestId: uuidSchema,
  /** 实际使用的任务角色。 */
  role: modelTaskRoleSchema,
  /** 实际调用的能力。 */
  operation: modelOperationSchema,
  /** 交互与后台额度分类。 */
  lane: z.enum(['interactive', 'background']),
  /** 本调用固定使用的完整配置版本。 */
  configVersion: positiveIntegerSchema,
  /** 配置中的供应商标识，不含密钥或地址。 */
  providerId: z.string(),
  /** 请求中的模型名称；实际响应名称另见尝试记录。 */
  model: z.string(),
  /** 当前逻辑调用状态。 */
  status: modelCallStatusSchema,
  /** 受控失败分类；成功或进行中为 null。 */
  errorCode: z.number().int().nullable(),
  /** 通过校验的诊断结果；失败、未知、取消及进行中均为 null。 */
  result: modelResultSchema.nullable(),
  /** 每次尝试分别计量，包含失败或取消后的消耗。 */
  attempts: z.array(modelAttemptSchema).max(3),
  /** 调用创建时间。 */
  createdAt: utcDateTimeSchema,
  /** 逻辑调用结束时间；进行中为 null。 */
  finishedAt: utcDateTimeSchema.nullable(),
};
/** 管理者可回查的隔离诊断结果，不表示业务状态已提交。 */
export const modelCallSchema: z.ZodObject<typeof modelCallShape> = z.object(modelCallShape);
/** 模型诊断调用响应。 */
export type ModelCall = z.infer<typeof modelCallSchema>;

const budgetViewShape = {
  /** 当前配置允许的每日总量。 */
  limit: dailyModelBudgetSchema,
  /** 已结算及未知用量的预留总和，可能因供应商超报而高于上限。 */
  charged: z.object({
    requests: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    costMicros: z.number().int().nonnegative(),
  }),
};
/** 额度和实际占用分开返回，降额不截断历史用量。 */
export const modelBudgetViewSchema: z.ZodObject<typeof budgetViewShape> = z.object(budgetViewShape);
const modelUsageShape = {
  /** 本响应统计的 UTC 日期，格式 YYYY-MM-DD。 */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** 当前额度配置版本，旧调用仍保留自己的配置版本。 */
  configVersion: positiveIntegerSchema,
  /** 金额统一为 USD 微单位，属于按配置价格计算的估计。 */
  currency: z.literal('USD'),
  /** 所有任务共用的额度。 */
  global: modelBudgetViewSchema,
  /** 各任务的独立额度与用量。 */
  tasks: z.record(modelTaskRoleSchema, modelBudgetViewSchema),
  /** 仍在有效期限内的实际请求数。 */
  activeRequests: z.number().int().nonnegative(),
};
/** 当前日额度查询。 */
export const modelUsageSchema: z.ZodObject<typeof modelUsageShape> = z.object(modelUsageShape);
/** 当前日额度响应。 */
export type ModelUsage = z.infer<typeof modelUsageSchema>;

const modelHardLimitsShape = {
  /** 部署级每日资源上限。 */
  dailyBudget: dailyModelBudgetSchema,
  /** 普通配置允许选择的最大总并发。 */
  maxConcurrent: z.number().int().min(1).max(16),
  /** 普通配置允许选择的最大后台并发。 */
  backgroundConcurrent: z.number().int().min(0).max(8),
};
/** 部署上限在启动时读取，不可通过普通配置接口提高。 */
export const modelHardLimitsSchema: z.ZodObject<typeof modelHardLimitsShape, z.core.$strict> = z
  .object(modelHardLimitsShape)
  .strict();
/** 模型部署资源上限。 */
export type ModelHardLimits = z.infer<typeof modelHardLimitsSchema>;
const modelProviderInfoShape = {
  /** 部署登记的稳定供应商标识。 */
  id: z.string(),
  /** 明确区分确定性测试与真实外部接口。 */
  kind: z.enum(['test', 'openai-compatible']),
  /** 部署者明确声明的协议能力，不代表已验证所有模型。 */
  capabilities: z.array(modelOperationSchema),
  /** 需要的凭据是否已配置；不返回值、环境变量名或私有地址。 */
  credentialConfigured: z.boolean(),
  /** 本阶段不提供流式传输，后续 F06 接入。 */
  streaming: z.literal(false),
  /** 本阶段不发送工具定义或执行工具调用。 */
  tools: z.literal(false),
  /** 本阶段不发送图片内容。 */
  vision: z.literal(false),
};
/** 供应商公共能力声明。 */
export const modelProviderInfoSchema: z.ZodObject<typeof modelProviderInfoShape> =
  z.object(modelProviderInfoShape);
const modelProviderCatalogShape = {
  /** 当前部署可引用的供应商，不包含凭据。 */
  providers: z.array(modelProviderInfoSchema),
  /** 只有部署层可以调整的上限。 */
  hardLimits: modelHardLimitsSchema,
};
/** 模型管理入口的能力与部署限制。 */
export const modelProviderCatalogSchema: z.ZodObject<typeof modelProviderCatalogShape> =
  z.object(modelProviderCatalogShape);
/** 供应商能力目录响应。 */
export type ModelProviderCatalog = z.infer<typeof modelProviderCatalogSchema>;
