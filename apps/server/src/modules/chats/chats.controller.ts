import { CurrentOwner } from '../auth/current-owner';
import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  chatEventsQuerySchema,
  chatEventCursorSchema,
  uuidSchema,
  chatDeliverySchema,
  stopChatSchema,
  chatMessageQuerySchema,
  createChatSchema,
  idPaginationQuerySchema,
  sendChatMessageSchema,
} from '@memory-weave/contracts';
import type {
  ChatEventsQuery,
  CreateChat,
  IdPaginationQuery,
  ChatDelivery,
  StopChat,
  SendChatMessage,
  ChatMessageQuery,
  Chat,
  ChatList,
  ChatMessageList,
  SentChatMessage,
} from '@memory-weave/contracts';
import { RequestHeader, ZodValidationPipe } from '../../http/zod-validation.pipe';
import { ChatEventsService } from './chat-events.service';
import { ChatsService } from './chats.service';

/** 各终端共用的已认证私聊接口；发送与事件传输分开。 */
@Controller('chats')
export class ChatsController {
  /** 初始化聊天接口所需的服务。 */
  constructor(
    @Inject(ChatsService) private readonly chats: ChatsService,
    @Inject(ChatEventsService) private readonly events: ChatEventsService,
  ) {}

  /** 创建与指定伴侣的独立私聊。 */
  @Post()
  create(
    @CurrentOwner() ownerId: string,
    @Body(new ZodValidationPipe(createChatSchema)) body: CreateChat,
  ): Promise<Chat> {
    return this.chats.create(ownerId, body);
  }

  /** 分页查询用户的聊天会话。 */
  @Get()
  list(
    @CurrentOwner() ownerId: string,
    @Query(new ZodValidationPipe(idPaginationQuerySchema)) query: IdPaginationQuery,
  ): Promise<ChatList> {
    return this.chats.list(ownerId, query);
  }

  /**
   * 返回聊天资源配置。
   *
   * 公开非敏感聊天参数，便于各终端采用同一资源限制。
   */
  @Get('configuration')
  settings(): import('@memory-weave/contracts').ChatConfiguration {
    return this.chats.settings();
  }

  /**
   * 建立聊天事件流并恢复消息推送。
   *
   * 重连优先采用 Last-Event-ID，否则使用显式 afterSequence。
   */
  @Get(':id/events')
  stream(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(chatEventsQuerySchema)) query: ChatEventsQuery,
    @RequestHeader('Last-Event-ID', new ZodValidationPipe(chatEventCursorSchema.optional()))
    lastEventId: number | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const cursor = lastEventId ?? query.afterSequence;
    return this.events.stream(ownerId, id, cursor, request, response);
  }

  /**
   * 记录终端对指定消息的送达确认。
   *
   * 确认终端已经取得指定原文，不代表人类已阅读。
   */
  @Post(':id/deliveries')
  acknowledge(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(chatDeliverySchema)) body: ChatDelivery,
  ): Promise<null> {
    return this.chats.acknowledge(ownerId, id, body);
  }

  /**
   * 停止指定轮次的聊天回复。
   *
   * 只停止指定轮次，不误伤已经开始的后续回复。
   */
  @Post(':id/stop')
  stop(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(stopChatSchema)) body: StopChat,
  ): Promise<Chat> {
    return this.chats.stop(ownerId, id, body);
  }

  /** 查询聊天当前回复与任务状态。 */
  @Get(':id')
  get(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<Chat> {
    return this.chats.get(ownerId, id);
  }

  /**
   * 保存用户输入并安排回复任务。
   *
   * 保存输入并建立持久回复任务，不等待模型。
   */
  @Post(':id/messages')
  send(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(sendChatMessageSchema)) body: SendChatMessage,
  ): Promise<SentChatMessage> {
    return this.chats.send(ownerId, id, body);
  }

  /**
   * 分页查询聊天原文历史。
   *
   * 查看正式原文；此操作不确认用户已经收到。
   */
  @Get(':id/messages')
  history(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(chatMessageQuerySchema)) query: ChatMessageQuery,
  ): Promise<ChatMessageList> {
    return this.chats.history(ownerId, id, query);
  }
}
