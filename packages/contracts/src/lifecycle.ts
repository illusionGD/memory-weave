import { z } from 'zod';
import { uuidSchema, positiveIntegerSchema, utcDateTimeSchema } from './common';
import { taskSchema } from './tasks';

const companionCommandShape = {
  /** 命令身份；超时后沿用，不重复改变代次。 */
  requestId: uuidSchema,
  /** 明确区分重置与删除实例。 */
  kind: z.enum(['reset_companion', 'delete_companion']),
  /** 目标实例，不影响其他实例的私有状态。 */
  companionId: uuidSchema,
  /** 页面所见运行代次。 */
  runtimeEpoch: positiveIntegerSchema,
  /** 页面所见实例版本，过时命令不会生效。 */
  expectedVersion: positiveIntegerSchema,
};
const messageTargetShape = {
  /** 明确选择的原文或流式片段身份。 */
  messageId: uuidSchema,
  /** 选择时的内容版本。 */
  contentVersion: positiveIntegerSchema,
};
const messageTargetSchema: z.ZodObject<typeof messageTargetShape> = z.object(messageTargetShape);
const messageCommandShape = {
  /** 此次删除的幂等命令身份。 */
  requestId: uuidSchema,
  /** 删除原文及其依赖内容，不删除实例。 */
  kind: z.literal('delete_messages'),
  /** 同一会话内的明确选择。 */
  conversationId: uuidSchema,
  /** 当前会话版本。 */
  expectedVersion: positiveIntegerSchema,
  /** 至少一条，最多一百条；传递依赖由服务端分批计算。 */
  messages: z
    .array(messageTargetSchema)
    .min(1)
    .max(100)
    .refine(
      (items) => new Set(items.map((item) => item.messageId.toLowerCase())).size === items.length,
    ),
};
/** 生命周期命令由管理端显式提交，模型不能自行扩展清除范围。 */
export const lifecycleCommandSchema = z.union([
  z.object(companionCommandShape).strict(),
  z.object(messageCommandShape).strict(),
]);
/** 生命周期命令，不包含待删除正文。 */
export type LifecycleCommand = z.infer<typeof lifecycleCommandSchema>;

const lifecycleOperationShape = {
  /** 稳定操作身份，恢复清理不会改变。 */
  id: uuidSchema,
  /** 已经持久生效的操作种类。 */
  kind: z.enum(['reset_companion', 'delete_companion', 'delete_messages']),
  /** 实例操作的目标；消息操作为空。 */
  companionId: uuidSchema.nullable(),
  /** 消息操作的会话；实例操作为空。 */
  conversationId: uuidSchema.nullable(),
  /** 被停止的实例代次。 */
  previousEpoch: positiveIntegerSchema.nullable(),
  /** 重置后的代次；删除不创建新代次。 */
  nextEpoch: positiveIntegerSchema.nullable(),
  /** pending 表示限制已生效但尚未清完；completed 才表示当前模块完成清理。 */
  status: z.enum(['pending', 'completed']),
  /** 当前清理阶段，用于诊断与后续模块接入。 */
  stage: z.string(),
  /** 已提交的清理记录数，不冒充精确百分比。 */
  processedRecords: z.number().int().nonnegative(),
  /** 已完成阶段数。 */
  completedStages: z.number().int().nonnegative(),
  /** 本次固定清理协议的阶段数。 */
  totalStages: positiveIntegerSchema,
  /** 执行、暂停、失败与重试状态。 */
  task: taskSchema,
  /** 限制生效时间。 */
  createdAt: utcDateTimeSchema,
  /** 完成全部清理的时间。 */
  completedAt: utcDateTimeSchema.nullable(),
};
/** 不保存或返回正文的最小生命周期日志。 */
export const lifecycleOperationSchema: z.ZodObject<typeof lifecycleOperationShape> =
  z.object(lifecycleOperationShape);
/** 跨终端共用的操作状态。 */
export type LifecycleOperation = z.infer<typeof lifecycleOperationSchema>;
/** 按稳定身份分页读取生命周期记录。 */
export const lifecycleListSchema = z.object({
  items: z.array(lifecycleOperationSchema),
  nextAfterId: uuidSchema.nullable(),
});
/** 生命周期列表。 */
export type LifecycleList = z.infer<typeof lifecycleListSchema>;

/** 恢复已中断清理的幂等命令，不重复修改代次或范围。 */
export const retryLifecycleSchema = z.object({ requestId: uuidSchema }).strict();
/** 恢复清理请求。 */
export type RetryLifecycle = z.infer<typeof retryLifecycleSchema>;
