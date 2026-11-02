import {
  chatListSchema,
  chatSchema,
  chatMessageListSchema,
  sentChatMessageSchema,
} from '@memory-weave/contracts';
import type {
  Chat,
  ChatList,
  ChatMessageList,
  CreateChat,
  SentChatMessage,
  SendChatMessage,
  ChatDelivery,
} from '@memory-weave/contracts';
import { request, requestJson } from './http';

/**
 * 创建用户与伴侣的私聊。
 *
 * 创建私聊；网络重试继续使用调用者保留的 requestId。
 */
export function createChat(input: CreateChat): Promise<Chat> {
  return requestJson('/api/chats', chatSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}
/** 查询聊天详情及当前回复状态。 */
export function getChat(id: string): Promise<Chat> {
  return requestJson(`/api/chats/${id}`, chatSchema);
}
/** 分页查询私聊会话列表。 */
export function listChats(afterId?: string): Promise<ChatList> {
  return requestJson(`/api/chats?limit=20${afterId ? `&afterId=${afterId}` : ''}`, chatListSchema);
}
/**
 * 分页查询聊天原文历史。
 *
 * 每次取一页历史，最新页或向前翻页均不会标记送达。
 */
export function chatHistory(id: string, beforeSequence?: number): Promise<ChatMessageList> {
  return requestJson(
    `/api/chats/${id}/messages?limit=50${beforeSequence ? `&beforeSequence=${beforeSequence}` : ''}`,
    chatMessageListSchema,
  );
}
/**
 * 发送用户消息并安排聊天回复。
 *
 * 发布用户原文；响应只表示已保存并已安排任务。
 */
export function sendChatMessage(id: string, input: SendChatMessage): Promise<SentChatMessage> {
  return requestJson(`/api/chats/${id}/messages`, sentChatMessageSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}
/**
 * 停止指定聊天轮次的回复。
 *
 * 只停止用户看到的轮次，不能停止后续新回复。
 */
export function stopChat(id: string, runId: string): Promise<Chat> {
  return requestJson(`/api/chats/${id}/stop`, chatSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId }),
  });
}
/**
 * 提交聊天消息的终端送达回执。
 *
 * 页面已经显示原文后，按确切版本发送回执。
 */
export function acknowledgeChat(id: string, input: ChatDelivery): Promise<void> {
  return request(`/api/chats/${id}/deliveries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}
