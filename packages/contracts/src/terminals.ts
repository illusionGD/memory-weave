import { z } from 'zod';
import {
  positiveIntegerSchema,
  nonnegativeIntegerSchema,
  utcDateTimeSchema,
  uuidSchema,
} from './common';

/** 已登记的终端能力。每种能力都需要单独实现和授权。 */
export const terminalToolSchema = z.enum(['diagnostic.echo']);
export type TerminalTool = z.infer<typeof terminalToolSchema>;

const workspaceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);
const terminalSecretSchema = z.string().regex(/^[a-f0-9]{64}$/u);

/** 由已登录的拥有者登记设备。凭据只经 TLS 或本机连接提交。 */
export const registerTerminalSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  secret: terminalSecretSchema,
});
export type RegisterTerminal = z.infer<typeof registerTerminalSchema>;

/** 注册身份与本次在线环境分别持久化。 */
export const terminalSchema = z.strictObject({
  id: uuidSchema,
  name: z.string(),
  state: z.enum(['online', 'offline', 'revoked']),
  lastHeartbeatAt: utcDateTimeSchema.nullable(),
  workspaceId: workspaceIdSchema.nullable(),
  capabilities: z.array(terminalToolSchema),
});
export type Terminal = z.infer<typeof terminalSchema>;

/** 终端用设备凭据建立新连接，并声明当前工作区和实现的工具。 */
export const connectTerminalSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  capabilities: z.array(terminalToolSchema).max(1),
});
export type ConnectTerminal = z.infer<typeof connectTerminalSchema>;

/** 心跳、执行领取和回执必须与当前连接匹配。 */
export const terminalConnectionSchema = z.strictObject({ connectionId: uuidSchema });
export type TerminalConnection = z.infer<typeof terminalConnectionSchema>;

export const terminalConnectionViewSchema = z.strictObject({
  ...terminalConnectionSchema.shape,
  /** 由数据库时间确定的在线期限。 */
  expiresAt: utcDateTimeSchema,
});
export type TerminalConnectionView = z.infer<typeof terminalConnectionViewSchema>;

const terminalScopeShape = {
  conversationId: uuidSchema,
  companionId: uuidSchema,
  runtimeEpoch: positiveIntegerSchema,
};
const grantShape = {
  ...terminalScopeShape,
  workspaceId: workspaceIdSchema,
  tool: terminalToolSchema,
};

/** 授权只由登录持有者变更，固定到一个伴侣代次、会话和工作区。 */
export const updateTerminalGrantSchema = z.strictObject({
  ...grantShape,
  expectedVersion: nonnegativeIntegerSchema,
  enabled: z.boolean(),
});
export type UpdateTerminalGrant = z.infer<typeof updateTerminalGrantSchema>;

export const terminalGrantSchema = z.strictObject({
  ...grantShape,
  id: uuidSchema,
  terminalId: uuidSchema,
  version: positiveIntegerSchema,
  enabled: z.boolean(),
});
export type TerminalGrant = z.infer<typeof terminalGrantSchema>;

/** 发布原文的稳定位置，可作为动作来源。动作授权仍来自显式指令。 */
export const terminalActionSourceSchema = z.strictObject({
  messageId: uuidSchema,
  contentVersion: positiveIntegerSchema,
});
export type TerminalActionSource = z.infer<typeof terminalActionSourceSchema>;

const echoArgumentsSchema = z.strictObject({ text: z.string().min(1).max(512) });

/** 已登录拥有者请求执行一次有界诊断。请求 ID 用于安全重试。 */
export const requestTerminalActionSchema = z.strictObject({
  ...grantShape,
  requestId: uuidSchema,
  terminalId: uuidSchema,
  source: terminalActionSourceSchema.optional(),
  arguments: echoArgumentsSchema,
});
export type RequestTerminalAction = z.infer<typeof requestTerminalActionSchema>;

export const terminalActionStateSchema = z.enum([
  'queued',
  'dispatched',
  'unknown',
  'succeeded',
  'failed',
  'not-executed',
  'cancelled',
  'invalidated',
]);
export type TerminalActionState = z.infer<typeof terminalActionStateSchema>;

export const terminalActionSchema = z.strictObject({
  ...grantShape,
  id: uuidSchema,
  terminalId: uuidSchema,
  source: terminalActionSourceSchema.nullable(),
  requestedBy: z.enum(['user', 'companion']),
  /** Web 用户命令或后端伴侣任务，目标设备另由 terminalId 标识。 */
  origin: z.enum(['web', 'backend']),
  state: terminalActionStateSchema,
  result: echoArgumentsSchema.nullable(),
  createdAt: utcDateTimeSchema,
  deadlineAt: utcDateTimeSchema,
});
export type TerminalAction = z.infer<typeof terminalActionSchema>;

/** 动作在开始执行前固定令牌；未知状态只能用确切回执核对。 */
export const terminalDispatchSchema = z.strictObject({
  id: uuidSchema,
  tool: terminalToolSchema,
  workspaceId: workspaceIdSchema,
  claimId: uuidSchema,
  arguments: echoArgumentsSchema,
  deadlineAt: utcDateTimeSchema,
});
export type TerminalDispatch = z.infer<typeof terminalDispatchSchema>;

export const terminalReceiptSchema = z.strictObject({
  ...terminalConnectionSchema.shape,
  claimId: uuidSchema,
  outcome: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('succeeded'), result: echoArgumentsSchema }),
    z.strictObject({ state: z.literal('failed') }),
    z.strictObject({ state: z.literal('not-executed') }),
  ]),
});
export type TerminalReceipt = z.infer<typeof terminalReceiptSchema>;

/** 注入轮次的能力视图仅包含有权、在线且当前工作区支持的能力。 */
export const terminalCapabilitySchema = z.strictObject({
  terminalId: uuidSchema,
  workspaceId: workspaceIdSchema,
  tool: terminalToolSchema,
});
export type TerminalCapability = z.infer<typeof terminalCapabilitySchema>;
