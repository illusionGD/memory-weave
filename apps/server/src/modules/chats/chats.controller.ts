import type { Request, Response } from 'express';
import { z } from 'zod';
import { ChatEventsService } from './chat-events.service';
import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  chatDeliverySchema,
  stopChatSchema,
  chatMessageQuerySchema,
  createChatSchema,
  idPaginationQuerySchema,
  sendChatMessageSchema,
} from '@memory-weave/contracts';
import type { Chat, ChatList, ChatMessageList, SentChatMessage } from '@memory-weave/contracts';
import { parseId, parseInput } from '../shared/http';
import { ChatsService } from './chats.service';

/** 各终端共用的已认证私聊接口；发送与事件传输分开。 */
@Controller('chats')
export class ChatsController {
  constructor(
    @Inject(ChatsService) private readonly chats: ChatsService,
    @Inject(ChatEventsService) private readonly events: ChatEventsService,
  ) {}

  /** 创建与指定伴侣的独立私聊。 */
  @Post()
  create(@Body() body: unknown): Promise<Chat> {
    return this.chats.create(parseInput(createChatSchema, body));
  }

  /** 分页查看已启用聊天的会话。 */
  @Get()
  list(@Query() query: unknown): Promise<ChatList> {
    return this.chats.list(parseInput(idPaginationQuerySchema, query));
  }

  /** 公开非敏感聊天参数，便于各终端采用同一资源限制。 */
  @Get('configuration')
  settings(): import('@memory-weave/contracts').ChatConfiguration {
    return this.chats.settings();
  }

  /** 重连优先采用 Last-Event-ID，否则使用显式 afterSequence。 */
  @Get(':id/events')
  stream(
    @Param('id') id: string,
    @Query() query: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const input = parseInput(
      z
        .object({ afterSequence: z.coerce.number().int().min(0).max(2147483647).default(0) })
        .strict(),
      query,
    );
    const cursor =
      request.get('Last-Event-ID') === undefined
        ? input.afterSequence
        : parseInput(z.coerce.number().int().min(0).max(2147483647), request.get('Last-Event-ID'));
    return this.events.stream(parseId(id), cursor, request, response);
  }

  /** 确认终端已经取得指定原文，不代表人类已阅读。 */
  @Post(':id/deliveries')
  acknowledge(@Param('id') id: string, @Body() body: unknown): Promise<null> {
    return this.chats.acknowledge(parseId(id), parseInput(chatDeliverySchema, body));
  }

  /** 只停止指定轮次，不误伤已经开始的后续回复。 */
  @Post(':id/stop')
  stop(@Param('id') id: string, @Body() body: unknown): Promise<Chat> {
    return this.chats.stop(parseId(id), parseInput(stopChatSchema, body));
  }

  /** 查看当前回复与任务状态。 */
  @Get(':id')
  get(@Param('id') id: string): Promise<Chat> {
    return this.chats.get(parseId(id));
  }

  /** 保存输入并建立持久回复任务，不等待模型。 */
  @Post(':id/messages')
  send(@Param('id') id: string, @Body() body: unknown): Promise<SentChatMessage> {
    return this.chats.send(parseId(id), parseInput(sendChatMessageSchema, body));
  }

  /** 查看正式原文；此操作不确认用户已经收到。 */
  @Get(':id/messages')
  history(@Param('id') id: string, @Query() query: unknown): Promise<ChatMessageList> {
    return this.chats.history(parseId(id), parseInput(chatMessageQuerySchema, query));
  }
}
