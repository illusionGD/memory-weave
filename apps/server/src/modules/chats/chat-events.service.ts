import { API_CODES, API_RESPONSES } from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { Request, Response } from 'express';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiException } from '../../http/api-exception';
import { AuthService } from '../auth/auth.service';
import { readSessionCookie } from '../auth/session-cookie';
import { ChatsService } from './chats.service';

/** 以持久原文序号重放消息，状态从持久任务重新读取；连接本身不持有生成任务。 */
@Injectable()
export class ChatEventsService implements OnModuleDestroy {
  private readonly connections = new Set<AbortController>();
  constructor(
    @Inject(ChatsService) private readonly chats: ChatsService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  /**
   * SSE 每次最多查询 50 条原文，慢连接等待 drain，断开不取消模型生成。
   * @param id 已验证的私聊身份。
   * @param cursor 上一次成功处理的正式发布序号。
   * @param request 用于周期复核会话是否仍有效。
   * @param response 直接发送 SSE，帧内数据仍遵循统一数字 code 协议。
   */
  async stream(id: string, cursor: number, request: Request, response: Response): Promise<void> {
    const initial = await this.chats.get(id);
    if (cursor > initial.lastSequence) throw new ApiException(API_CODES.INVALID_REQUEST);
    const settings = this.chats.settings();
    if (this.connections.size >= settings.maxEventConnections)
      throw new ApiException(API_CODES.RATE_LIMITED);
    const connection = new AbortController();
    this.connections.add(connection);
    const close = (): void => connection.abort();
    response.once('close', close);
    response.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    let stateHash = '';
    let heartbeatAt = Date.now();
    const write = async (text: string): Promise<void> => {
      if (connection.signal.aborted) return;
      if (!response.write(text)) await once(response, 'drain', { signal: connection.signal });
    };
    const event = async (kind: string, data: unknown, sequence?: number): Promise<void> => {
      await write(
        `${sequence === undefined ? '' : `id: ${sequence}\n`}event: ${kind}\ndata: ${JSON.stringify({ code: API_CODES.OK, data, message: API_RESPONSES[API_CODES.OK].message })}\n\n`,
      );
    };
    try {
      while (!connection.signal.aborted) {
        if (!this.auth.hasSession(readSessionCookie(request))) {
          await write(
            `event: error\ndata: ${JSON.stringify({ code: API_CODES.AUTH_REQUIRED, data: null, message: API_RESPONSES[API_CODES.AUTH_REQUIRED].message })}\n\n`,
          );
          break;
        }
        const state = await this.chats.get(id);
        const next = JSON.stringify(state);
        if (next !== stateHash) {
          await event('state', state);
          stateHash = next;
        }
        // 先发送失效状态，让在线终端清空缓存；清理期间不重放原文。
        const items = state.availability === 'cleaning' ? [] : await this.chats.after(id, cursor);
        if (items.length) {
          const latest = await this.chats.get(id);
          if (
            latest.contentRevision !== state.contentRevision ||
            latest.availability !== state.availability
          )
            continue;
        }
        for (const item of items) {
          await event('message', item, item.message.sequence!);
          cursor = item.message.sequence!;
        }
        if (Date.now() - heartbeatAt >= 10000) {
          await write(': heartbeat\n\n');
          heartbeatAt = Date.now();
        }
        if (items.length < 50)
          await delay(settings.eventPollMs, undefined, { signal: connection.signal });
      }
    } catch {
      // 断线和查询失败都交由客户端带游标重连，不回显异常或把流当作完整 JSON。
    } finally {
      this.connections.delete(connection);
      response.off('close', close);
      response.end();
    }
  }

  /** 应用关闭先结束事件连接，避免长连接阻塞后端重启。 */
  onModuleDestroy(): void {
    for (const connection of this.connections) connection.abort();
  }
}
