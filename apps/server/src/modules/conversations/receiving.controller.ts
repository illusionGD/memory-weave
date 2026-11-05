import { CurrentOwner } from '../auth/current-owner';
import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import {
  uuidSchema,
  companionSequenceQuerySchema,
  receiveMessagesRequestSchema,
  sourceLookupQuerySchema,
} from '@memory-weave/contracts';
import type {
  CompanionSequenceQuery,
  SourceLookupQuery,
  ReceiveMessagesRequest,
  ConversationProgressResponse,
  MessageListResponse,
  PublishedMessage,
  ReceiveMessagesResponse,
} from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { ReceivingService } from './receiving.service';

/** 管理者代理当前伴侣执行受范围约束的查询及接收操作。 */
@Controller('companions/:companionId')
export class ReceivingController {
  /** 初始化原文接收接口所需的服务。 */
  constructor(@Inject(ReceivingService) private readonly receiving: ReceivingService) {}

  /**
   * 分页查询伴侣可见的已发布消息。
   *
   * 查询有权查看的已发布原文，不产生读取、整理或用户交付记录。
   */
  @Get('conversations/:id/messages')
  listMessages(
    @CurrentOwner() ownerId: string,
    @Param('companionId', new ZodValidationPipe(uuidSchema)) companionId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(companionSequenceQuerySchema)) query: CompanionSequenceQuery,
  ): Promise<MessageListResponse> {
    return this.receiving.listMessages(ownerId, companionId, id, query);
  }

  /**
   * 查询指定消息版本的原文及来源。
   *
   * 回查指定正文版本及其来源，草稿、私聊越权或版本不存在均不可读取。
   */
  @Get('sources/:messageId')
  source(
    @CurrentOwner() ownerId: string,
    @Param('companionId', new ZodValidationPipe(uuidSchema)) companionId: string,
    @Param('messageId', new ZodValidationPipe(uuidSchema)) messageId: string,
    @Query(new ZodValidationPipe(sourceLookupQuerySchema)) query: SourceLookupQuery,
  ): Promise<PublishedMessage> {
    return this.receiving.source(ownerId, companionId, messageId, query);
  }

  /**
   * 查询伴侣在会话中的读取与整理进度。
   *
   * 查看当前实例的逐条读取与待整理记录，不把查询当作实际取得原文。
   */
  @Get('conversations/:id/progress')
  progress(
    @CurrentOwner() ownerId: string,
    @Param('companionId', new ZodValidationPipe(uuidSchema)) companionId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(companionSequenceQuerySchema)) query: CompanionSequenceQuery,
  ): Promise<ConversationProgressResponse> {
    return this.receiving.progress(ownerId, companionId, id, query);
  }

  /**
   * 接收一批原文并记录伴侣的读取状态。
   *
   * 明确取得当前范围内的完整原文，独立登记读取，不推进整理或终端交付。
   */
  @Post('conversations/:id/receive')
  receive(
    @CurrentOwner() ownerId: string,
    @Param('companionId', new ZodValidationPipe(uuidSchema)) companionId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(receiveMessagesRequestSchema)) body: ReceiveMessagesRequest,
  ): Promise<ReceiveMessagesResponse> {
    return this.receiving.receive(ownerId, companionId, id, body);
  }
}
