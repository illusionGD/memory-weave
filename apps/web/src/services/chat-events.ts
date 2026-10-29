import { apiResponseSchema, chatMessageSchema, chatSchema } from '@memory-weave/contracts';
import type { ChatMessage, Chat } from '@memory-weave/contracts';
import { ApiError, readApiError } from './http';

/** 事件只包含已持久原文或最新持久状态，正文不会当作 HTML。 */
export type ChatEvent =
  { kind: 'message'; sequence: number; message: ChatMessage } | { kind: 'state'; chat: Chat };

/**
 * 读取一条有界 SSE 连接；断线由页面携带最后已处理序号重连。
 * @param id 私聊身份。
 * @param cursor 最后成功处理的消息序号。
 * @param signal 页面离开时取消连接，不取消后端模型任务。
 * @param onEvent 已通过共享契约验证的消息或状态。
 * @param onOpen 认证通过且流响应头已收到。
 */
export async function readChatEvents(
  id: string,
  cursor: number,
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
  onOpen: () => void,
): Promise<void> {
  const stalled = new AbortController();
  let timeout = window.setTimeout(() => stalled.abort(), 30000);
  try {
    const response = await fetch(`/api/chats/${id}/events?afterSequence=${cursor}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'text/event-stream' },
      signal: AbortSignal.any([signal, stalled.signal]),
    });
    if (!response.ok) throw await readApiError(response);
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
      throw new ApiError('服务没有返回可用的消息流。');
    onOpen();
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    try {
      while (!signal.aborted) {
        const item = await reader.read();
        if (item.done) break;
        window.clearTimeout(timeout);
        timeout = window.setTimeout(() => stalled.abort(), 30000);
        buffer += decoder.decode(item.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (frame.length > 262144) throw new ApiError('消息事件超过页面允许的大小。');
          const lines = frame.split('\n');
          const kind = lines.find((line) => line.startsWith('event: '))?.slice(7);
          if (!kind) continue;
          const body = apiResponseSchema.safeParse(
            JSON.parse(
              lines.find((line) => line.startsWith('data: '))?.slice(6) ?? 'null',
            ) as unknown,
          );
          if (!body.success) throw new ApiError('消息事件与当前页面不匹配。');
          if (kind === 'error')
            throw new ApiError(
              body.data.message,
              body.data.code === 401 ? 401 : null,
              body.data.code,
            );
          if (kind === 'message') {
            const sequenceText = lines.find((line) => line.startsWith('id: '))?.slice(4) ?? '';
            const parsed = chatMessageSchema.safeParse(body.data.data);
            if (
              !/^\d+$/.test(sequenceText) ||
              !parsed.success ||
              parsed.data.message.sequence !== Number(sequenceText)
            )
              throw new ApiError('消息序号或正文无法识别。');
            onEvent({ kind, sequence: Number(sequenceText), message: parsed.data });
          } else if (kind === 'state') {
            const parsed = chatSchema.safeParse(body.data.data);
            if (!parsed.success) throw new ApiError('聊天状态与当前页面不匹配。');
            onEvent({ kind, chat: parsed.data });
          }
        }
        if (buffer.length > 262144) throw new ApiError('消息事件超过页面允许的大小。');
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } finally {
    window.clearTimeout(timeout);
  }
}
