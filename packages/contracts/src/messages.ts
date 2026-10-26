import { z } from 'zod';
import {
  nonnegativeIntegerSchema,
  positiveIntegerSchema,
  utcDateTimeSchema,
  uuidSchema,
} from './common.js';

const userSpeakerRequestShape = {
  /** 以已认证部署的用户身份保存消息，用户标识由服务端决定。 */
  kind: z.literal('user'),
};

/** 用户发言请求身份，不允许请求自带用户或 owner 标识。 */
export const userSpeakerRequestSchema: z.ZodObject<typeof userSpeakerRequestShape, z.core.$strict> =
  z.object(userSpeakerRequestShape).strict();

const companionSpeakerRequestShape = {
  /** 管理者代理指定伴侣发言；不表示模型生成或实例自主行为。 */
  kind: z.literal('companion'),
  /** 已加入本会话的稳定实例标识。 */
  companionId: uuidSchema,
  /** 发言实例的预期运行代次，必须显式提供。 */
  runtimeEpoch: positiveIntegerSchema,
};

/** 管理者代理伴侣发言的请求身份。 */
export const companionSpeakerRequestSchema: z.ZodObject<
  typeof companionSpeakerRequestShape,
  z.core.$strict
> = z.object(companionSpeakerRequestShape).strict();

/** 保存消息所用身份请求，与服务端返回的完整身份分别定义。 */
export const speakerRequestSchema = z.discriminatedUnion('kind', [
  userSpeakerRequestSchema,
  companionSpeakerRequestSchema,
]);

const userActorShape = {
  /** 经服务端确认的用户身份。 */
  kind: z.literal('user'),
  /** 部署用户标识，由服务端依据已认证 owner 及成员关系确定。 */
  userId: uuidSchema,
};

/** 服务端解析后的用户发言者身份。 */
export const userActorSchema: z.ZodObject<typeof userActorShape> = z.object(userActorShape);

const companionActorShape = {
  /** 经服务端确认的伴侣身份。 */
  kind: z.literal('companion'),
  /** 发言者的稳定实例标识。 */
  companionId: uuidSchema,
  /** 发言时绑定的运行代次。 */
  runtimeEpoch: positiveIntegerSchema,
};

/** 服务端解析后的伴侣发言者身份。 */
export const companionActorSchema: z.ZodObject<typeof companionActorShape> =
  z.object(companionActorShape);

/** 实际发言身份不能由正文中的自称或引用文本改变。 */
export const actorSchema = z.discriminatedUnion('kind', [userActorSchema, companionActorSchema]);

const messageSourceShape = {
  /** 被引用的已发布原文标识；F02 必须在当前会话内且发言者可见。 */
  messageId: uuidSchema,
  /** 被引用原文的确切内容版本，不是该消息的保存修订号。 */
  contentVersion: positiveIntegerSchema,
  /** reference 表示引用关系；report 表示转述关系，不等同于亲历。 */
  relation: z.enum(['reference', 'report']),
};

/** 请求和响应共用的稳定原文来源引用，不能用于绕过私聊范围。 */
export const messageSourceSchema: z.ZodObject<typeof messageSourceShape, z.core.$strict> = z
  .object(messageSourceShape)
  .strict();

const saveMessageRequestShape = {
  /** 保存正文命令的 UUID 幂等键，与发布命令的幂等键分别记录。 */
  requestId: uuidSchema,
  /** 请求的发言身份；服务端复核所属成员、当前代次及可见范围。 */
  speaker: speakerRequestSchema,
  /** 当前会话的预期并发控制版本，过期时拒绝写入。 */
  expectedConversationVersion: positiveIntegerSchema,
  /** 单份消息正文，长度为 1～4000 个 UTF-16 代码单元。 */
  text: z.string().min(1).max(4000),
  /** 内容发生的 UTC 时间；省略或 null 表示未知，不能以服务端接收时间替代。 */
  occurredAt: utcDateTimeSchema.nullable().optional(),
  /** 内容适用期的起始 UTC 时间；省略或 null 表示未知，不等同发生时间。 */
  validFrom: utcDateTimeSchema.nullable().optional(),
  /** 内容适用期的结束 UTC 时间；省略或 null 表示未知，已知时不得早于起点。 */
  validUntil: utcDateTimeSchema.nullable().optional(),
  /** statement 为陈述，report 为转述，inference 为推断，setting 为设定；默认陈述。 */
  epistemicKind: z.enum(['statement', 'report', 'inference', 'setting']).default('statement'),
  /** unspecified 为未指定，real 为现实，fictional 为虚构；默认未指定。 */
  reality: z.enum(['unspecified', 'real', 'fictional']).default('unspecified'),
  /** 回复的本会话可见已发布消息标识；省略或 null 表示没有回复对象。 */
  replyToMessageId: uuidSchema.nullable().optional(),
  /** 最多十条不重复的已发布原文来源；省略时为空，不能跨会话引用。 */
  sources: z.array(messageSourceSchema).max(10).default([]),
};

/** 只保存草稿的请求，不分配发布序号、不登记已读或待整理项。 */
export const saveMessageRequestSchema: z.ZodObject<typeof saveMessageRequestShape, z.core.$strict> =
  z
    .object(saveMessageRequestShape)
    .strict()
    .superRefine((value, context) => {
      const sourceKeys = value.sources.map(
        (source) => `${source.messageId.toLowerCase()}:${source.contentVersion}:${source.relation}`,
      );
      if (new Set(sourceKeys).size !== sourceKeys.length) {
        context.addIssue({
          code: 'custom',
          path: ['sources'],
          message: '同一原文版本的同类来源关系不能重复',
        });
      }
      if (
        value.validFrom !== undefined &&
        value.validFrom !== null &&
        value.validUntil !== undefined &&
        value.validUntil !== null &&
        Date.parse(value.validUntil) < Date.parse(value.validFrom)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['validUntil'],
          message: '适用期结束时间不得早于开始时间',
        });
      }
    });

const publishMessageRequestShape = {
  /** 发布命令的 UUID 幂等键；同键同载荷重放首次发布结果。 */
  requestId: uuidSchema,
  /** 草稿的预期保存修订号，与正文 contentVersion 分开校验。 */
  expectedRevision: positiveIntegerSchema,
  /** 会话的预期并发控制版本，服务端持锁分配唯一发布序号。 */
  expectedConversationVersion: positiveIntegerSchema,
};

/** 将已保存草稿正式发布，并原子登记可见伴侣的待整理项。 */
export const publishMessageRequestSchema: z.ZodObject<
  typeof publishMessageRequestShape,
  z.core.$strict
> = z.object(publishMessageRequestShape).strict();

const messageCommonShape = {
  /** 单份共同原文的稳定消息标识，不按接收伴侣复制。 */
  id: uuidSchema,
  /** 原文所属部署的持久 owner 标识。 */
  ownerId: uuidSchema,
  /** 原文所属会话的稳定标识。 */
  conversationId: uuidSchema,
  /** 经校验的发言成员关系标识。 */
  speakerMembershipId: uuidSchema,
  /** 服务端确定的实际发言身份，用户响应包含 userId。 */
  speaker: actorSchema,
  /** 公共消息结构版本，当前固定为 1。 */
  schemaVersion: z.literal(1),
  /** 正文内容版本，来源引用及读取记录绑定此值；发布不改变此版本。 */
  contentVersion: positiveIntegerSchema,
  /** 消息保存修订号，草稿初始为 1，发布后为 2；与内容版本独立。 */
  revision: positiveIntegerSchema,
  /** 唯一保存的完整正文，长度为 1～4000 个 UTF-16 代码单元。 */
  text: z.string().min(1).max(4000),
  /** 内容发生的 UTC 时间；无法确定时为 null，与服务端接收和实例实际取得时间独立。 */
  occurredAt: utcDateTimeSchema.nullable(),
  /** 服务端首次保存正文的 UTC 时间，不表示伴侣已读取。 */
  receivedAt: utcDateTimeSchema,
  /** 内容适用期的起始 UTC 时间；未知时为 null。 */
  validFrom: utcDateTimeSchema.nullable(),
  /** 内容适用期的结束 UTC 时间；未知时为 null。 */
  validUntil: utcDateTimeSchema.nullable(),
  /** 陈述、转述、推断或设定的认识类别，不由真实/虚构字段代替。 */
  epistemicKind: z.enum(['statement', 'report', 'inference', 'setting']),
  /** 内容的现实属性：未指定、现实或虚构。 */
  reality: z.enum(['unspecified', 'real', 'fictional']),
  /** user_input 为用户输入；admin_companion_input 为管理者代理伴侣输入。 */
  sourceKind: z.enum(['user_input', 'admin_companion_input']),
  /** 被回复的消息标识；无回复对象时为 null。 */
  replyToMessageId: uuidSchema.nullable(),
  /** 经权限校验的原文来源引用，最多十条。 */
  sources: z.array(messageSourceSchema).max(10),
};

const draftMessageShape = {
  ...messageCommonShape,
  /** draft 表示仅已保存，尚未正式发布。 */
  state: z.literal('draft'),
  /** 草稿没有发布序号，固定为 null，不能参与已发布消息分页。 */
  sequence: z.null(),
  /** 草稿尚未发布，固定为 null。 */
  publishedAt: z.null(),
};

/** 管理者可读取的草稿，伴侣消息和来源查询不能返回此类型。 */
export const draftMessageSchema: z.ZodObject<typeof draftMessageShape> =
  z.object(draftMessageShape);

const publishedMessageShape = {
  ...messageCommonShape,
  /** published 表示原文已正式发布，不代表已读、已整理或用户已收到。 */
  state: z.literal('published'),
  /** 服务端在本会话内分配的正整数发布序号。 */
  sequence: positiveIntegerSchema,
  /** 首次正式发布的 UTC 时间。 */
  publishedAt: utcDateTimeSchema,
};

/** 已发布原文；不同伴侣读取时使用相同消息标识及内容版本。 */
export const publishedMessageSchema: z.ZodObject<typeof publishedMessageShape> =
  z.object(publishedMessageShape);

/** 消息的保存与发布状态，通过判别字段保留各自的序号和时间约束。 */
export const messageSchema = z.discriminatedUnion('state', [
  draftMessageSchema,
  publishedMessageSchema,
]);

const messageListResponseShape = {
  /** 当前页有权查看的已发布消息，按发布序号升序排列；查询本身不写已读。 */
  items: z.array(publishedMessageSchema).max(100),
  /** 下一页的发布序号起点；没有更多可见消息时为 null。 */
  nextAfterSequence: positiveIntegerSchema.nullable(),
};

/** 管理者或伴侣视角下的已发布消息分页响应。 */
export const messageListResponseSchema: z.ZodObject<typeof messageListResponseShape> =
  z.object(messageListResponseShape);

const readReceiptShape = {
  /** 实际取得记录的稳定标识。 */
  id: uuidSchema,
  /** 记录所属部署的持久 owner 标识。 */
  ownerId: uuidSchema,
  /** 实际取得正文的伴侣标识，A 的取得记录不改变 B。 */
  companionId: uuidSchema,
  /** 取得正文时的运行代次。 */
  runtimeEpoch: positiveIntegerSchema,
  /** 被取得正文所属的会话标识。 */
  conversationId: uuidSchema,
  /** 实际取得的确切消息标识。 */
  messageId: uuidSchema,
  /** 实际取得的确切内容版本。 */
  contentVersion: positiveIntegerSchema,
  /** 此伴侣首次取得该消息版本的 UTC 时间，不是模型理解或用户交付时间。 */
  acquiredAt: utcDateTimeSchema,
  /** 已取得正文范围的 UTF-16 起点，包含此位置；F02 完整正文固定从零开始。 */
  startOffset: z.literal(0),
  /** 已取得正文范围的 UTF-16 终点，不包含此位置；F02 等于正文长度。 */
  endOffset: positiveIntegerSchema.max(4000),
};

/** 实例取得原文的记录，独立于普通查询、发布、记忆整理和用户终端交付。 */
export const readReceiptSchema: z.ZodObject<typeof readReceiptShape> = z.object(readReceiptShape);

const processingRangeShape = {
  /** 待整理区间记录的稳定标识。 */
  id: uuidSchema,
  /** 区间所属部署的持久 owner 标识。 */
  ownerId: uuidSchema,
  /** 需要整理此原文的伴侣标识。 */
  companionId: uuidSchema,
  /** 此待整理项所属的运行代次。 */
  runtimeEpoch: positiveIntegerSchema,
  /** 待整理原文所属的会话标识。 */
  conversationId: uuidSchema,
  /** 待整理的确切消息标识；不能用最大游标跳过尚未整理的消息。 */
  messageId: uuidSchema,
  /** 待整理的确切内容版本。 */
  contentVersion: positiveIntegerSchema,
  /** 待整理区间起始序号，包含此序号；F02 每条消息单独登记。 */
  startSequence: positiveIntegerSchema,
  /** 待整理区间结束序号，包含此序号；F02 与起始序号相同。 */
  endSequence: positiveIntegerSchema,
  /** 目标阶段为记忆提取，F02 尚不执行此阶段。 */
  stage: z.literal('memory_extraction'),
  /** F02 只登记 pending，不提供伪造整理完成的命令。 */
  status: z.literal('pending'),
  /** 随消息正式发布而登记此区间的 UTC 时间。 */
  createdAt: utcDateTimeSchema,
};

/** 与读取记录分离的逐条待整理区间。 */
export const processingRangeSchema: z.ZodObject<typeof processingRangeShape> =
  z.object(processingRangeShape);

const receiveMessagesRequestShape = {
  /** 本次接收命令的 UUID 幂等键；重试复用第一次取得的确切批次。 */
  requestId: uuidSchema,
  /** 接收实例的预期运行代次，必须显式提供且在重试时重新校验。 */
  runtimeEpoch: positiveIntegerSchema,
  /** 当前成员关系的预期权限版本，过期时拒绝接收。 */
  expectedPermissionVersion: positiveIntegerSchema,
  /** 本次只取得大于此序号的可见已发布消息；默认零。 */
  afterSequence: nonnegativeIntegerSchema.default(0),
  /** 本次最多取得的完整消息条数，默认 20，范围为 1～100。 */
  limit: z.number().int().min(1).max(100).default(20),
};

/** 管理者发起的实例接收操作，取得完整正文后逐条写入独立读取记录。 */
export const receiveMessagesRequestSchema: z.ZodObject<
  typeof receiveMessagesRequestShape,
  z.core.$strict
> = z.object(receiveMessagesRequestShape).strict();

const receiveMessagesResponseShape = {
  /** 已持久化接收批次的稳定标识，同键同载荷重试复用此批次。 */
  batchId: uuidSchema,
  /** 此次实际取得原文的伴侣标识。 */
  companionId: uuidSchema,
  /** 此次接收绑定的运行代次。 */
  runtimeEpoch: positiveIntegerSchema,
  /** 本批次所属的会话标识。 */
  conversationId: uuidSchema,
  /** 此批次首次实际取得正文的 UTC 时间；幂等重试不更新该时间。 */
  acquiredAt: utcDateTimeSchema,
  /** 此批次确切取得的完整已发布消息；新增消息不改变重试返回的此列表。 */
  items: z.array(publishedMessageSchema).max(100),
  /** 本批次最后一条消息的序号，可用于后续新接收命令；空批次为 null。 */
  nextAfterSequence: positiveIntegerSchema.nullable(),
};

/** 接收批次结果，只证明本次实例操作取得了这些正文。 */
export const receiveMessagesResponseSchema: z.ZodObject<typeof receiveMessagesResponseShape> =
  z.object(receiveMessagesResponseShape);

const messageProgressShape = {
  /** 当前进度对应的已发布原文标识。 */
  messageId: uuidSchema,
  /** 当前进度绑定的确切正文内容版本。 */
  contentVersion: positiveIntegerSchema,
  /** 当前消息的发布序号，不用于推断较小序号已整理。 */
  sequence: positiveIntegerSchema,
  /** 本伴侣实际取得该版本完整正文的记录；尚未取得时为 null。 */
  readReceipt: readReceiptSchema.nullable(),
  /** F02 所有可见已发布原文均待整理；取得正文不会改变此值。 */
  processing: z.literal('pending'),
  /** 尚未记录用户终端交付；不能由已发布或已读状态推断交付成功。 */
  delivery: z.literal('not_recorded'),
};

/** 某伴侣对一条可见原文的独立读取、整理及交付状态。 */
export const messageProgressSchema: z.ZodObject<typeof messageProgressShape> =
  z.object(messageProgressShape);

const conversationProgressResponseShape = {
  /** 当前页各条可见已发布消息的独立进度，按发布序号排列。 */
  items: z.array(messageProgressSchema).max(100),
  /** 下一页的发布序号起点；没有更多可见消息时为 null。 */
  nextAfterSequence: positiveIntegerSchema.nullable(),
};

/** 伴侣会话进度分页响应；读取此响应不会修改任何状态。 */
export const conversationProgressResponseSchema: z.ZodObject<
  typeof conversationProgressResponseShape
> = z.object(conversationProgressResponseShape);

/** 保存请求中的发言身份。 */
export type SpeakerRequest = z.infer<typeof speakerRequestSchema>;
/** 服务端确认的实际发言者身份。 */
export type Actor = z.infer<typeof actorSchema>;
/** 对已发布原文确切版本的来源引用。 */
export type MessageSource = z.infer<typeof messageSourceSchema>;
/** 保存草稿请求，默认字段已规范化。 */
export type SaveMessageRequest = z.infer<typeof saveMessageRequestSchema>;
/** 正式发布草稿请求。 */
export type PublishMessageRequest = z.infer<typeof publishMessageRequestSchema>;
/** 尚未分配序号的消息草稿。 */
export type DraftMessage = z.infer<typeof draftMessageSchema>;
/** 正式发布的单份共同原文。 */
export type PublishedMessage = z.infer<typeof publishedMessageSchema>;
/** 管理者可查询的草稿或正式消息。 */
export type Message = z.infer<typeof messageSchema>;
/** 已发布消息分页响应。 */
export type MessageListResponse = z.infer<typeof messageListResponseSchema>;
/** 实例实际取得完整正文的记录。 */
export type ReadReceipt = z.infer<typeof readReceiptSchema>;
/** 每条消息独立的待整理区间。 */
export type ProcessingRange = z.infer<typeof processingRangeSchema>;
/** 取得消息正文的接收请求，默认分页字段已规范化。 */
export type ReceiveMessagesRequest = z.infer<typeof receiveMessagesRequestSchema>;
/** 持久化接收批次的响应。 */
export type ReceiveMessagesResponse = z.infer<typeof receiveMessagesResponseSchema>;
/** 某伴侣对单条消息的读取及待整理状态。 */
export type MessageProgress = z.infer<typeof messageProgressSchema>;
/** 某伴侣对会话各条可见消息的进度响应。 */
export type ConversationProgressResponse = z.infer<typeof conversationProgressResponseSchema>;
