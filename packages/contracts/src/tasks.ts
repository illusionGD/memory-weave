import { z } from 'zod';
import { modelProbeSchema } from './models';
import {
  uuidSchema,
  positiveIntegerSchema,
  nonnegativeIntegerSchema,
  utcDateTimeSchema,
  idPaginationQueryShape,
} from './common';

/** 任务状态；阻塞表示缺少处理器或结果需核对，不等于失败后自动重试。 */
export const taskStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'paused',
  'blocked',
  'succeeded',
  'failed',
  'cancelled',
]);
/** 当前注册的任务种类，诊断不能写入真实经历。 */
export const taskKindSchema = z.enum([
  'diagnostic',
  'model_probe',
  'memory_extraction',
  'persona_initialization',
  'chat_reply',
]);
const diagnosticTaskShape = {
  /** 客户端命令身份，同键同内容返回原任务。 */
  requestId: uuidSchema,
  /** 确定性诊断实际执行的步骤数，1～20，不调用模型。 */
  steps: z.number().int().min(1).max(20),
};
/** 创建不含业务副作用的恢复诊断。 */
export const diagnosticTaskSchema: z.ZodObject<typeof diagnosticTaskShape, z.core.$strict> = z
  .object(diagnosticTaskShape)
  .strict();
const taskProgressShape = {
  /** 已持久完成的步骤数，不是估计百分比。 */
  completedSteps: nonnegativeIntegerSchema,
  /** 已知总步骤数；业务尚未定义时为 null。 */
  totalSteps: positiveIntegerSchema.nullable(),
};
const taskProgressSchema: z.ZodObject<typeof taskProgressShape> = z.object(taskProgressShape);
const taskScopeShape = {
  /** 实际处理实例；部署级诊断为空。 */
  companionId: uuidSchema.nullable(),
  /** 与实例绑定的运行代次，不自动改成最新值。 */
  runtimeEpoch: positiveIntegerSchema.nullable(),
  /** 关联的共享会话，诊断为空。 */
  conversationId: uuidSchema.nullable(),
};
/** 任务归属不替代来源可见性检查。 */
export const taskScopeSchema: z.ZodObject<typeof taskScopeShape> = z.object(taskScopeShape);
const taskAttemptShape = {
  /** 每次接管的递增代号，用于拒绝旧执行者提交。 */
  number: positiveIntegerSchema,
  /** 此次领取使用的调度配置版本。 */
  configVersion: positiveIntegerSchema,
  /** 执行尝试的最终状态，过期不表示外部操作未发生。 */
  status: z.enum([
    'running',
    'succeeded',
    'failed',
    'expired',
    'cancelled',
    'paused',
    'waiting',
    'blocked',
  ]),
  /** 受控原因标识，不回显原始异常或输入。 */
  reason: z.string().nullable(),
  /** 实际领取时间。 */
  startedAt: utcDateTimeSchema,
  /** 尝试结束时间，仍运行时为 null。 */
  finishedAt: utcDateTimeSchema.nullable(),
};
const taskAttemptSchema: z.ZodObject<typeof taskAttemptShape> = z.object(taskAttemptShape);
const taskShape = {
  /** 持久任务身份，接管和重试均保持不变。 */
  id: uuidSchema,
  /** 任务种类。 */
  kind: taskKindSchema,
  /** 当前持久状态。 */
  status: taskStatusSchema,
  /** 当前步骤或检查点名称。 */
  stage: z.string(),
  /** 已保存的实际进度。 */
  progress: taskProgressSchema,
  /** 处理实例和会话范围。 */
  scope: taskScopeSchema,
  /** 等待、阻塞或失败的受控原因。 */
  reason: z.string().nullable(),
  /** 已知关联模型调用；输出详情通过模型诊断接口读取。 */
  modelCallId: uuidSchema.nullable(),
  /** 后续最早领取时间，不承诺届时必定执行。 */
  availableAt: utcDateTimeSchema,
  /** 当前租约到期时间；无执行者时为空。 */
  leaseExpiresAt: utcDateTimeSchema.nullable(),
  /** 创建时间。 */
  createdAt: utcDateTimeSchema,
  /** 最近一次状态或检查点提交时间。 */
  updatedAt: utcDateTimeSchema,
  /** 有界尝试历史；默认最多 3 次，可配置到 10 次。 */
  attempts: z.array(taskAttemptSchema),
};
/** 管理者可观察的持久任务，不导出任务输入和租约令牌。 */
export const taskSchema: z.ZodObject<typeof taskShape> = z.object(taskShape);
const taskListQueryShape = {
  /** 上一页末尾 UUID，省略时从第一页开始。 */
  afterId: idPaginationQueryShape.afterId,
  /** 每页 1～100 条，默认 20。 */
  limit: idPaginationQueryShape.limit,
  /** 可选状态筛选。 */
  status: taskStatusSchema.optional(),
  /** 可选实例筛选，仍限定当前 owner。 */
  companionId: uuidSchema.optional(),
};
/** 有界分页，避免一次载入全部历史。 */
export const taskListQuerySchema: z.ZodObject<typeof taskListQueryShape, z.core.$strict> = z
  .object(taskListQueryShape)
  .strict();
const taskListShape = {
  /** 本页任务及各自进度。 */
  items: z.array(taskSchema),
  /** 下一页 UUID 游标，无更多条目时为空。 */
  nextAfterId: uuidSchema.nullable(),
};
/** 当前部署的任务分页。 */
export const taskListSchema: z.ZodObject<typeof taskListShape> = z.object(taskListShape);
export type DiagnosticTask = z.infer<typeof diagnosticTaskSchema>;
export type Task = z.infer<typeof taskSchema>;
export type TaskKind = z.infer<typeof taskKindSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskScope = z.infer<typeof taskScopeSchema>;
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;
export type TaskList = z.infer<typeof taskListSchema>;

const taskConfigurationShape = {
  /** 是否允许新领取；关闭不撤销已经发出的操作，默认 true。 */
  enabled: z.boolean(),
  /** 当前部署的任务并发数，默认 1，实现上限 4；模型另受 F03 后台预算约束。 */
  maxConcurrent: z.number().int().min(1).max(4),
  /** 无新工作的轮询间隔（毫秒），默认 1000，范围 100～30000。 */
  pollMs: z.number().int().min(100).max(30000),
  /** 租约长度（毫秒），默认 30000，范围 1000～300000；心跳间隔为此值的三分之一。 */
  leaseMs: z.number().int().min(1000).max(300000),
  /** 单次接管的最长时间（毫秒），默认 180000，范围 1000～600000，不小于租约。 */
  attemptTimeoutMs: z.number().int().min(1000).max(600000),
  /** 每任务累计领取次数上限，默认 3，范围 1～10；配置切换不清零。 */
  maxAttempts: z.number().int().min(1).max(10),
  /** 重试退避起点（毫秒），默认 1000，范围 100～60000。 */
  retryBaseMs: z.number().int().min(100).max(60000),
  /** 指数退避上限（毫秒），默认 60000，范围 100～3600000，不小于起点。 */
  retryMaxMs: z.number().int().min(100).max(3600000),
  /** 每轮最多转交多少条 outbox，默认 20，范围 1～100。 */
  outboxBatchSize: z.number().int().min(1).max(100),
};
/** 调度配置仅允许部署级完整版本发布，无实例覆盖或模型自行提额。 */
export const taskConfigurationSchema: z.ZodObject<typeof taskConfigurationShape, z.core.$strict> = z
  .object(taskConfigurationShape)
  .strict();
const taskConfigurationVersionShape = {
  /** 当前不可变版本号。 */
  version: positiveIntegerSchema,
  /** 默认或部署者发布的来源。 */
  source: z.enum(['default', 'deployment']),
  /** 同一次调度采用的完整配置。 */
  config: taskConfigurationSchema,
  /** 该版本首次创建时间。 */
  createdAt: utcDateTimeSchema,
};
/** 调度有效配置和历史均使用相同格式。 */
export const taskConfigurationVersionSchema: z.ZodObject<typeof taskConfigurationVersionShape> =
  z.object(taskConfigurationVersionShape);
const updateTaskConfigurationShape = {
  /** 发布命令的幂等身份。 */
  requestId: uuidSchema,
  /** 预期当前版本，拒绝覆盖并发修改。 */
  expectedVersion: positiveIntegerSchema,
  /** 完整新配置；不会重置尝试次数或模型用量。 */
  config: taskConfigurationSchema,
};
/** 普通运行参数发布入口，服务端同时验证参数间关系。 */
export const updateTaskConfigurationSchema: z.ZodObject<
  typeof updateTaskConfigurationShape,
  z.core.$strict
> = z.object(updateTaskConfigurationShape).strict();
export type TaskConfiguration = z.infer<typeof taskConfigurationSchema>;
export type TaskConfigurationVersion = z.infer<typeof taskConfigurationVersionSchema>;
export type UpdateTaskConfiguration = z.infer<typeof updateTaskConfigurationSchema>;

const taskOutboxShape = {
  /** 持久待办标识；业务事务提交前不会对外可见。 */
  id: uuidSchema,
  /** 当前只转交已发布消息；后续业务模块单独登记处理器。 */
  kind: z.literal('message_published'),
  /** dispatched 仅表示各实例任务已登记，不表示模型理解或形成记忆。 */
  status: z.enum(['pending', 'dispatched', 'blocked']),
  /** 原始消息标识，不复制消息正文。 */
  sourceId: uuidSchema,
  /** 对应的确切内容版本。 */
  sourceVersion: positiveIntegerSchema,
  /** 阻塞时的受控原因。 */
  reason: z.string().nullable(),
  /** 原业务事务登记时间。 */
  createdAt: utcDateTimeSchema,
  /** 任务登记完成时间；未转交时为空。 */
  dispatchedAt: utcDateTimeSchema.nullable(),
};
/** outbox 的管理视图，内部收件人及私有输入不导出。 */
export const taskOutboxSchema: z.ZodObject<typeof taskOutboxShape> = z.object(taskOutboxShape);
const taskOutboxListShape = {
  /** 本页持久待办。 */
  items: z.array(taskOutboxSchema),
  /** 下一页游标。 */
  nextAfterId: uuidSchema.nullable(),
};
/** outbox 采用有界 UUID 分页。 */
export const taskOutboxListSchema: z.ZodObject<typeof taskOutboxListShape> =
  z.object(taskOutboxListShape);
export type TaskOutbox = z.infer<typeof taskOutboxSchema>;
export type TaskOutboxList = z.infer<typeof taskOutboxListSchema>;

const queuedModelProbeShape = {
  /** 创建命令身份；实际模型调用身份由任务持久生成。 */
  requestId: modelProbeSchema.shape.requestId,
  /** 预期的模型配置版本，排队期间变更不会静默采用新模型。 */
  expectedConfigVersion: modelProbeSchema.shape.expectedConfigVersion,
  /** 本次诊断的任务角色，沿用该角色独立配置和预算。 */
  role: modelProbeSchema.shape.role,
  /** 文本、结构化或 embedding 操作。 */
  operation: modelProbeSchema.shape.operation,
  /** 1～4000 字符的诊断输入；为恢复保存在主库，不作为真实经历。 */
  inputText: modelProbeSchema.shape.inputText,
  /** 队列诊断固定使用后台容量，不能挤占为交互保留的名额。 */
  lane: z.literal('background').default('background'),
};
/** 通过持久任务运行 F03 诊断；输入为恢复所需而存入主库，不写入真实经历。 */
export const queuedModelProbeSchema: z.ZodObject<typeof queuedModelProbeShape, z.core.$strict> = z
  .object(queuedModelProbeShape)
  .strict();
export type QueuedModelProbe = z.infer<typeof queuedModelProbeSchema>;
