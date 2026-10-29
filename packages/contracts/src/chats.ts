import { z } from 'zod';
import {
  uuidSchema,
  positiveIntegerSchema,
  nonnegativeIntegerSchema,
  utcDateTimeSchema,
} from './common';
import { messageSchema } from './messages';
import { taskSchema } from './tasks';

const createChatShape = {
  /** 新私聊命令身份；同键重放返回原会话。 */
  requestId: uuidSchema,
  /** 仅包含当前用户与这一个伴侣。 */
  companionId: uuidSchema,
  /** 创建时固定的实例代次，不能自动切到新代次。 */
  runtimeEpoch: positiveIntegerSchema,
  /** 私聊标题。 */
  title: z.string().trim().min(1).max(80),
};
/** Web 和后续终端共享的私聊创建命令。 */
export const createChatSchema: z.ZodObject<typeof createChatShape, z.core.$strict> = z
  .object(createChatShape)
  .strict();
/** 私聊创建输入。 */
export type CreateChat = z.infer<typeof createChatSchema>;

const sendChatMessageShape = {
  /** 单次发送身份，网络重试沿用此值。 */
  requestId: uuidSchema,
  /** 用户原文，保持内容不变；纯空白不发送。 */
  text: z
    .string()
    .min(1)
    .max(4000)
    .refine((value) => value.trim().length > 0),
};
/** 输入直接保存并触发回复，不要求先等待提取或整理。 */
export const sendChatMessageSchema: z.ZodObject<typeof sendChatMessageShape, z.core.$strict> = z
  .object(sendChatMessageShape)
  .strict();
/** 发送原文命令。 */
export type SendChatMessage = z.infer<typeof sendChatMessageSchema>;

const chatContextSourceShape = {
  /** 实际送入上下文的原文标识。 */
  messageId: uuidSchema,
  /** 精确原文版本，不以最大游标替代。 */
  contentVersion: positiveIntegerSchema,
};
const chatContextSourceSchema: z.ZodObject<typeof chatContextSourceShape> =
  z.object(chatContextSourceShape);
const chatContextShape = {
  /** 原稿阶段的显式初始约束；旧轮次缺省以保持其模型输入身份。 */
  explicitLocks: z.array(z.string()).optional(),
  /** 本轮固定的当前人格版本；不重复注入旧初始人格。 */
  personaVersionId: uuidSchema,
  /** 按发布顺序固定的原文集合。 */
  sources: z.array(chatContextSourceSchema).max(500),
  /** 未选入的更早历史截止序号；零表示未省略。 */
  omittedThroughSequence: nonnegativeIntegerSchema,
  /** 当前只有 Web 聊天环境，没有外部工具能力。 */
  environment: z.literal('web'),
  /** 构建时固定的用户显示名称，不是登录凭据。 */
  userName: z.string(),
};
/** 本轮实际采用的上下文来源；原文和人格仍沿版本引用回查。 */
export const chatContextSchema: z.ZodObject<typeof chatContextShape> = z.object(chatContextShape);
/** 可审查的上下文快照。 */
export type ChatContext = z.infer<typeof chatContextSchema>;

const chatRunShape = {
  /** 回复轮次身份，也是其持久任务身份。 */
  id: uuidSchema,
  /** 对应会话。 */
  conversationId: uuidSchema,
  /** 此轮要处理的最新用户原文。 */
  triggerMessageId: uuidSchema,
  /** 被新补充或显式停止打断时为 interrupted，否则沿用真实任务状态。 */
  status: z.union([taskSchema.shape.status, z.literal('interrupted')]),
  /** 底层任务与受控原因，可回查调用结果和用量。 */
  task: taskSchema,
  /** 已固定的上下文来源，尚未构建时为空。 */
  context: chatContextSchema.nullable(),
  /** 明确区分测试模型与真实模型；未准备时为空。 */
  mode: z.enum(['test', 'model']).nullable(),
  /** 供应商是否实际使用流式协议；不支持时整段返回。 */
  transport: z.enum(['stream', 'buffered']).nullable(),
  /** 本轮创建时间。 */
  createdAt: utcDateTimeSchema,
};
/** 回复状态；排队、生成、发布与用户收到分别记录。 */
export const chatRunSchema: z.ZodObject<typeof chatRunShape> = z.object(chatRunShape);
/** 可观察的回复轮次。 */
export type ChatRun = z.infer<typeof chatRunSchema>;
const chatShape = {
  /** 重置或删除实例后的旧对话只读；清理中的对话暂不可读取正文。 */
  availability: z.enum(['active', 'archived', 'cleaning']).default('active'),
  /** 生命周期变更后使终端缓存失效，与消息发布序号独立。 */
  contentRevision: z.number().int().positive().max(4_294_967_294).default(1),
  /** 清理中的操作身份，便于查看进度。 */
  lifecycleOperationId: uuidSchema.nullable().default(null),
  /** 稳定会话身份，与原文会话标识一致。 */
  id: uuidSchema,
  /** 本会话的唯一伴侣实例。 */
  companionId: uuidSchema,
  /** 会话绑定的实例代次。 */
  runtimeEpoch: positiveIntegerSchema,
  /** 显示标题。 */
  title: z.string(),
  /** 最新回复轮次，无输入时为 null。 */
  currentRun: chatRunSchema.nullable(),
  /** 最新正式发布序号，也是消息事件的重连游标。 */
  lastSequence: nonnegativeIntegerSchema,
  /** 创建时间。 */
  createdAt: utcDateTimeSchema,
};
/** 私聊持久状态。 */
export const chatSchema: z.ZodObject<typeof chatShape> = z.object(chatShape);
/** 私聊视图。 */
export type Chat = z.infer<typeof chatSchema>;
const chatMessageShape = {
  /** 单份正式原文；流式片段分别发布，不改写历史。 */
  message: messageSchema,
  /** 模型回复轮次；用户原文为 null。 */
  runId: uuidSchema.nullable(),
  /** 用户终端显式确认收到的时间；查询不会自动填入。 */
  deliveredAt: utcDateTimeSchema.nullable(),
};
/** 可用于跨终端合并同一回复的消息视图。 */
export const chatMessageSchema: z.ZodObject<typeof chatMessageShape> = z.object(chatMessageShape);
/** 私聊原文及传输状态。 */
export type ChatMessage = z.infer<typeof chatMessageSchema>;
const chatMessageQueryShape = {
  /** 向前加载历史；省略时取最近一页，返回项按发布顺序排列。 */
  beforeSequence: z.coerce.number().int().min(1).max(2147483647).optional(),
  /** 每页最多 100 条。 */
  limit: z.coerce.number().int().min(1).max(100).default(50),
};
/** 历史分页请求，不隐含接收回执。 */
export const chatMessageQuerySchema: z.ZodObject<typeof chatMessageQueryShape, z.core.$strict> = z
  .object(chatMessageQueryShape)
  .strict();
/** 历史分页输入。 */
export type ChatMessageQuery = z.infer<typeof chatMessageQuerySchema>;
const chatMessageListShape = {
  /** 本页按时间排列的原文。 */
  items: z.array(chatMessageSchema),
  /** 下一页向前查询游标；没有更早消息时为 null。 */
  nextBeforeSequence: nonnegativeIntegerSchema.nullable(),
};
/** 有界历史响应。 */
export const chatMessageListSchema: z.ZodObject<typeof chatMessageListShape> =
  z.object(chatMessageListShape);
/** 私聊历史页。 */
export type ChatMessageList = z.infer<typeof chatMessageListSchema>;
const sentChatMessageShape = {
  /** 已经落盘并正式发布的用户原文。 */
  message: messageSchema,
  /** 本次输入触发的回复轮次。 */
  run: chatRunSchema,
};
/** 发送回执不等待模型生成。 */
export const sentChatMessageSchema: z.ZodObject<typeof sentChatMessageShape> =
  z.object(sentChatMessageShape);
/** 原文发送结果。 */
export type SentChatMessage = z.infer<typeof sentChatMessageSchema>;
const chatListShape = {
  /** 当前页的私聊。 */
  items: z.array(chatSchema),
  /** 稳定 UUID 分页游标。 */
  nextAfterId: uuidSchema.nullable(),
};
/** 私聊列表响应。 */
export const chatListSchema: z.ZodObject<typeof chatListShape> = z.object(chatListShape);
/** 私聊列表。 */
export type ChatList = z.infer<typeof chatListSchema>;

const chatConfigurationShape = {
  /** 连续输入的短合并等待，默认 300 毫秒。 */
  mergeWindowMs: z.number().int().min(0).max(3000).default(300),
  /** 持续补充最多延后多久，默认 1500 毫秒。 */
  maxMergeWaitMs: z.number().int().min(0).max(10000).default(1500),
  /** 一次构建最多检查的最近原文条数，默认 200。 */
  historyMessages: z.number().int().min(10).max(500).default(200),
  /** 每个正式发布片段最多的 UTF-16 长度，默认 256。 */
  publishChunkChars: z.number().int().min(32).max(2000).default(256),
  /** 小增量最长合并等待，默认 100 毫秒。 */
  publishIntervalMs: z.number().int().min(10).max(1000).default(100),
  /** 单后端允许的同时事件连接数，默认 8；每个连接有界读取。 */
  maxEventConnections: z.number().int().min(1).max(32).default(8),
  /** 事件连接查询新事件的间隔，默认 250 毫秒。 */
  eventPollMs: z.number().int().min(100).max(5000).default(250),
};
/** 聊天参数集中部署，单轮保存快照；不覆盖模型、任务已有的预算与租约。 */
export const chatConfigurationSchema: z.ZodObject<typeof chatConfigurationShape, z.core.$strict> = z
  .object(chatConfigurationShape)
  .strict()
  .refine((value) => value.maxMergeWaitMs >= value.mergeWindowMs, {
    message: '最长合并等待不能小于短等待。',
  });
/** 已补齐默认值的聊天配置。 */
export type ChatConfiguration = z.infer<typeof chatConfigurationSchema>;

const chatDeliveryShape = {
  /** 当前浏览器标签页等接收终端的随机标识，不是认证凭据。 */
  terminalId: uuidSchema,
  /** 已在终端取得并显示的确切原文版本；不代表人类阅读或理解。 */
  messages: z
    .array(chatContextSourceSchema)
    .min(1)
    .max(100)
    .refine((items) => new Set(items.map((item) => item.messageId)).size === items.length),
};
/** 自然键去重的送达确认；重复确认保留首次时间。 */
export const chatDeliverySchema: z.ZodObject<typeof chatDeliveryShape, z.core.$strict> = z
  .object(chatDeliveryShape)
  .strict();
/** 终端送达回执。 */
export type ChatDelivery = z.infer<typeof chatDeliverySchema>;
const stopChatShape = {
  /** 只停止界面看到的这轮回复，过期命令不能停止后来的新轮次。 */
  runId: uuidSchema,
};
/** 显式停止以目标轮次幂等，不撤销已经发布的原文。 */
export const stopChatSchema: z.ZodObject<typeof stopChatShape, z.core.$strict> = z
  .object(stopChatShape)
  .strict();
/** 停止回复命令。 */
export type StopChat = z.infer<typeof stopChatSchema>;
