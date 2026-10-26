import { z } from 'zod';
import {
  nonnegativeIntegerSchema,
  positiveIntegerSchema,
  utcDateTimeSchema,
  uuidSchema,
} from './common.js';

const companionParticipantShape = {
  /** 作为初始成员加入会话的稳定实例标识。 */
  companionId: uuidSchema,
  /** 该实例的预期运行代次，必须显式提供且与当前代次一致。 */
  runtimeEpoch: positiveIntegerSchema,
};

/** 创建会话时指定的伴侣参与者，不能省略其运行代次。 */
export const companionParticipantSchema: z.ZodObject<
  typeof companionParticipantShape,
  z.core.$strict
> = z.object(companionParticipantShape).strict();

const createConversationRequestShape = {
  /** 创建会话命令的 UUID 幂等键。 */
  requestId: uuidSchema,
  /** private 固定两名参与者；group 在创建时包含 3～20 名参与者。 */
  kind: z.enum(['private', 'group']),
  /** 会话标题，去除首尾空白后为 1～80 个字符。 */
  title: z.string().trim().min(1).max(80),
  /** 是否将当前部署的用户作为初始成员加入，用户身份由服务端确定。 */
  includeUser: z.boolean(),
  /** 不重复的初始伴侣成员；与 includeUser 合计后校验会话人数。 */
  companions: z.array(companionParticipantSchema).min(1).max(20),
};

/** 创建会话请求；共享会话不归任何单个伴侣所有，F02 不允许后续改成员。 */
export const createConversationRequestSchema: z.ZodObject<
  typeof createConversationRequestShape,
  z.core.$strict
> = z
  .object(createConversationRequestShape)
  .strict()
  .superRefine((value, context) => {
    const count = value.companions.length + Number(value.includeUser);
    if (value.kind === 'private' ? count !== 2 : count < 3 || count > 20) {
      context.addIssue({
        code: 'custom',
        path: ['companions'],
        message: '私聊必须恰有两名参与者，群聊必须包含三至二十名参与者',
      });
    }
    if (
      new Set(value.companions.map((member) => member.companionId.toLowerCase())).size !==
      value.companions.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['companions'],
        message: '同一伴侣不能重复加入会话',
      });
    }
  });

const conversationShape = {
  /** 会话的稳定标识，不属于某个伴侣私有存储。 */
  id: uuidSchema,
  /** 所属部署的持久 owner 标识。 */
  ownerId: uuidSchema,
  /** private 表示双人私聊；group 表示创建时有 3～20 名成员的群聊。 */
  kind: z.enum(['private', 'group']),
  /** 会话显示标题，长度为 1～80。 */
  title: z.string().min(1).max(80),
  /** 会话的并发控制版本，写入时必须提交预期值。 */
  version: positiveIntegerSchema,
  /** 会话已分配的最后发布序号；尚无正式消息时为零，草稿不会推进此值。 */
  lastSequence: nonnegativeIntegerSchema,
  /** 会话首次创建的 UTC 时间。 */
  createdAt: utcDateTimeSchema,
};

/** 会话公共信息，不包含数据库幂等键或内部指纹。 */
export const conversationSchema: z.ZodObject<typeof conversationShape> =
  z.object(conversationShape);

const membershipCommonShape = {
  /** 成员关系记录的稳定标识。 */
  id: uuidSchema,
  /** 此成员关系所属部署的持久 owner 标识。 */
  ownerId: uuidSchema,
  /** 此成员关系所属的会话标识。 */
  conversationId: uuidSchema,
  /** 成员加入后的首个可见发布序号；F02 初始成员固定为 1。 */
  joinedSequence: positiveIntegerSchema,
  /** 成员退出对应的序号边界；尚未退出时为 null，F02 不开放退出。 */
  leftSequence: positiveIntegerSchema.nullable(),
  /** 此成员关系的权限版本，接收命令必须提交预期值。 */
  permissionVersion: positiveIntegerSchema,
};

const userMembershipShape = {
  ...membershipCommonShape,
  /** 用户成员，不接受正文或请求中的身份声明改变此类型。 */
  kind: z.literal('user'),
  /** 部署用户标识，由服务端确定。 */
  userId: uuidSchema,
  /** 用户成员没有伴侣标识，固定为 null。 */
  companionId: z.null(),
  /** 用户没有伴侣运行代次，固定为 null。 */
  runtimeEpoch: z.null(),
};

/** 用户会话成员。 */
export const userMembershipSchema: z.ZodObject<typeof userMembershipShape> =
  z.object(userMembershipShape);

const companionMembershipShape = {
  ...membershipCommonShape,
  /** 伴侣成员，运行代次与稳定实例标识分别记录。 */
  kind: z.literal('companion'),
  /** 伴侣成员没有用户标识，固定为 null。 */
  userId: z.null(),
  /** 参与会话的稳定实例标识。 */
  companionId: uuidSchema,
  /** 此成员关系绑定的运行代次。 */
  runtimeEpoch: positiveIntegerSchema,
};

/** 伴侣会话成员。 */
export const companionMembershipSchema: z.ZodObject<typeof companionMembershipShape> =
  z.object(companionMembershipShape);

/** 用户与伴侣互斥的成员身份。 */
export const conversationMemberSchema = z.discriminatedUnion('kind', [
  userMembershipSchema,
  companionMembershipSchema,
]);

const visibilityGrantShape = {
  /** 可见范围授权记录的稳定标识。 */
  id: uuidSchema,
  /** 授权所属部署的持久 owner 标识。 */
  ownerId: uuidSchema,
  /** 获得该范围授权的成员关系标识。 */
  membershipId: uuidSchema,
  /** 授权覆盖的起始发布序号，包含此序号。 */
  startSequence: positiveIntegerSchema,
  /** 授权覆盖的结束发布序号，包含此序号；持续开放时为 null。 */
  endSequence: positiveIntegerSchema.nullable(),
  /** membership 表示成员期间可见；history 表示单独授予的历史范围。 */
  kind: z.enum(['membership', 'history']),
  /** 产生此授权的成员权限版本。 */
  permissionVersion: positiveIntegerSchema,
};

/** 可见范围与成员身份分别建模，F02 只建立 membership 授权。 */
export const visibilityGrantSchema: z.ZodObject<typeof visibilityGrantShape> =
  z.object(visibilityGrantShape);

const conversationDetailShape = {
  /** 会话的公共元数据与并发控制版本。 */
  conversation: conversationSchema,
  /** 当前会话成员及各自的代次、成员可见起点与权限版本。 */
  members: z.array(conversationMemberSchema).min(2).max(20),
};

/** 创建会话及读取会话详情的响应。 */
export const conversationDetailSchema: z.ZodObject<typeof conversationDetailShape> =
  z.object(conversationDetailShape);

const conversationListResponseShape = {
  /** 当前页会话公共信息，按稳定 UUID 排序。 */
  items: z.array(conversationSchema).max(100),
  /** 下一页的 UUID 起点；没有更多会话时为 null。 */
  nextAfterId: uuidSchema.nullable(),
};

/** 会话分页响应。 */
export const conversationListResponseSchema: z.ZodObject<typeof conversationListResponseShape> =
  z.object(conversationListResponseShape);

/** 创建时的伴侣参与者。 */
export type CompanionParticipant = z.infer<typeof companionParticipantSchema>;
/** 创建会话请求。 */
export type CreateConversationRequest = z.infer<typeof createConversationRequestSchema>;
/** 会话公共信息。 */
export type Conversation = z.infer<typeof conversationSchema>;
/** 用户或伴侣的会话成员关系。 */
export type ConversationMember = z.infer<typeof conversationMemberSchema>;
/** 独立于成员身份的序号可见范围。 */
export type VisibilityGrant = z.infer<typeof visibilityGrantSchema>;
/** 会话及其成员详情。 */
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;
/** 会话分页响应。 */
export type ConversationListResponse = z.infer<typeof conversationListResponseSchema>;
