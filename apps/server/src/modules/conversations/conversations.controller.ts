import { CurrentOwner } from '../auth/current-owner';
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
    @CurrentOwner() ownerId: string,
    @Body(new ZodValidationPipe(createConversationRequestSchema)) body: CreateConversationRequest,
  ): Promise<ConversationDetail> {
    return this.conversations.create(ownerId, body);
  }

  /** 分页查询当前管理者的会话。 */
  @Get()
  list(
    @CurrentOwner() ownerId: string,
    @Query(new ZodValidationPipe(idPaginationQuerySchema)) query: IdPaginationQuery,
  ): Promise<ConversationListResponse> {
    return this.conversations.list(ownerId, query);
  }

  /** 查询会话详情。 */
  @Get(':id')
  get(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<ConversationDetail> {
    return this.conversations.get(ownerId, id);
  }

  /** 保存会话消息草稿。 */
  @Post(':id/messages')
  save(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(saveMessageRequestSchema)) body: SaveMessageRequest,
  ): Promise<Message> {
    return this.conversations.save(ownerId, id, body);
  }

  /**
   * 发布会话消息并登记待整理范围。
   *
   * 发布前重新校验代次、成员和来源，并登记各实例待整理范围。
   */
  @Post(':id/messages/:messageId/publish')
  publish(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('messageId', new ZodValidationPipe(uuidSchema)) messageId: string,
    @Body(new ZodValidationPipe(publishMessageRequestSchema)) body: PublishMessageRequest,
  ): Promise<Message> {
    return this.conversations.publish(ownerId, id, messageId, body);
  }

  /**
   * 分页查询会话已发布的原文。
   *
   * 管理者读取正式发布的共享历史，不登记已读。
   */
  @Get(':id/messages')
  listMessages(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(sequencePaginationQuerySchema)) query: SequencePaginationQuery,
  ): Promise<MessageListResponse> {
    return this.conversations.listMessages(ownerId, id, query);
  }

  /** 查询会话中的指定消息。 */
  @Get(':id/messages/:messageId')
  getMessage(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('messageId', new ZodValidationPipe(uuidSchema)) messageId: string,
  ): Promise<Message> {
    return this.conversations.getMessage(ownerId, id, messageId);
  }
}
