import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import {
  createConversationRequestSchema,
  idPaginationQuerySchema,
  publishMessageRequestSchema,
  saveMessageRequestSchema,
  sequencePaginationQuerySchema,
} from '@memory-weave/contracts';
import type {
  ConversationDetail,
  ConversationListResponse,
  Message,
  MessageListResponse,
} from '@memory-weave/contracts';
import { parseId, parseInput } from '../shared/http';
import { ConversationsService } from './conversations.service';

/** 已认证管理者的会话创建与原文操作，不代表模型自主行为。 */
@Controller('conversations')
export class ConversationsController {
  constructor(@Inject(ConversationsService) private readonly conversations: ConversationsService) {}

  /** 创建会话、初始成员与可见范围。 */
  @Post()
  create(@Body() body: unknown): Promise<ConversationDetail> {
    return this.conversations.create(parseInput(createConversationRequestSchema, body));
  }

  /** 分页列出当前管理者的会话。 */
  @Get()
  list(@Query() query: unknown): Promise<ConversationListResponse> {
    return this.conversations.list(parseInput(idPaginationQuerySchema, query));
  }

  /** 查看当前部署的会话详情。 */
  @Get(':id')
  get(@Param('id') id: string): Promise<ConversationDetail> {
    return this.conversations.get(parseId(id));
  }

  /** 保存草稿，正式发布通过单独命令执行。 */
  @Post(':id/messages')
  save(@Param('id') id: string, @Body() body: unknown): Promise<Message> {
    return this.conversations.save(parseId(id), parseInput(saveMessageRequestSchema, body));
  }

  /** 发布前重新校验代次、成员和来源，并登记各实例待整理范围。 */
  @Post(':id/messages/:messageId/publish')
  publish(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
  ): Promise<Message> {
    return this.conversations.publish(
      parseId(id),
      parseId(messageId),
      parseInput(publishMessageRequestSchema, body),
    );
  }

  /** 管理者读取正式发布的共享历史，不登记已读。 */
  @Get(':id/messages')
  listMessages(@Param('id') id: string, @Query() query: unknown): Promise<MessageListResponse> {
    return this.conversations.listMessages(
      parseId(id),
      parseInput(sequencePaginationQuerySchema, query),
    );
  }

  /** 查看本会话单条消息及草稿的保存状态。 */
  @Get(':id/messages/:messageId')
  getMessage(@Param('id') id: string, @Param('messageId') messageId: string): Promise<Message> {
    return this.conversations.getMessage(parseId(id), parseId(messageId));
  }
}
