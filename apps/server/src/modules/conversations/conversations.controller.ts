import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import {
  uuidSchema,
  createConversationRequestSchema,
  idPaginationQuerySchema,
  publishMessageRequestSchema,
  saveMessageRequestSchema,
  sequencePaginationQuerySchema,
} from '@memory-weave/contracts';
import type {
  CreateConversationRequest,
  IdPaginationQuery,
  SaveMessageRequest,
  PublishMessageRequest,
  SequencePaginationQuery,
  ConversationDetail,
  ConversationListResponse,
  Message,
  MessageListResponse,
} from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { ConversationsService } from './conversations.service';

/** 已认证管理者的会话创建与原文操作，不代表模型自主行为。 */
@Controller('conversations')
export class ConversationsController {
  /** 初始化会话接口所需的服务。 */
  constructor(@Inject(ConversationsService) private readonly conversations: ConversationsService) {}

  /** 创建会话及其初始成员。 */
  @Post()
  create(
    @Body(new ZodValidationPipe(createConversationRequestSchema)) body: CreateConversationRequest,
  ): Promise<ConversationDetail> {
    return this.conversations.create(body);
  }

  /** 分页查询当前管理者的会话。 */
  @Get()
  list(
    @Query(new ZodValidationPipe(idPaginationQuerySchema)) query: IdPaginationQuery,
  ): Promise<ConversationListResponse> {
    return this.conversations.list(query);
  }

  /** 查询会话详情。 */
  @Get(':id')
  get(@Param('id', new ZodValidationPipe(uuidSchema)) id: string): Promise<ConversationDetail> {
    return this.conversations.get(id);
  }

  /** 保存会话消息草稿。 */
  @Post(':id/messages')
  save(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(saveMessageRequestSchema)) body: SaveMessageRequest,
  ): Promise<Message> {
    return this.conversations.save(id, body);
  }

  /**
   * 发布会话消息并登记待整理范围。
   *
   * 发布前重新校验代次、成员和来源，并登记各实例待整理范围。
   */
  @Post(':id/messages/:messageId/publish')
  publish(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('messageId', new ZodValidationPipe(uuidSchema)) messageId: string,
    @Body(new ZodValidationPipe(publishMessageRequestSchema)) body: PublishMessageRequest,
  ): Promise<Message> {
    return this.conversations.publish(id, messageId, body);
  }

  /**
   * 分页查询会话已发布的原文。
   *
   * 管理者读取正式发布的共享历史，不登记已读。
   */
  @Get(':id/messages')
  listMessages(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(sequencePaginationQuerySchema)) query: SequencePaginationQuery,
  ): Promise<MessageListResponse> {
    return this.conversations.listMessages(id, query);
  }

  /** 查询会话中的指定消息。 */
  @Get(':id/messages/:messageId')
  getMessage(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('messageId', new ZodValidationPipe(uuidSchema)) messageId: string,
  ): Promise<Message> {
    return this.conversations.getMessage(id, messageId);
  }
}
