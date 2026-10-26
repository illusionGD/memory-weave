import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import {
  companionSequenceQuerySchema,
  receiveMessagesRequestSchema,
  sourceLookupQuerySchema,
} from '@memory-weave/contracts';
import type {
  ConversationProgressResponse,
  MessageListResponse,
  PublishedMessage,
  ReceiveMessagesResponse,
} from '@memory-weave/contracts';
import { parseId, parseInput } from '../shared/http';
import { ReceivingService } from './receiving.service';

/** 管理者代理当前伴侣执行受范围约束的查询及接收操作。 */
@Controller('companions/:companionId')
export class ReceivingController {
  constructor(@Inject(ReceivingService) private readonly receiving: ReceivingService) {}

  /** 查询有权查看的已发布原文，不产生读取、整理或用户交付记录。 */
  @Get('conversations/:id/messages')
  listMessages(
    @Param('companionId') companionId: string,
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<MessageListResponse> {
    return this.receiving.listMessages(
      parseId(companionId),
      parseId(id),
      parseInput(companionSequenceQuerySchema, query),
    );
  }

  /** 回查指定正文版本及其来源，草稿、私聊越权或版本不存在均不可读取。 */
  @Get('sources/:messageId')
  source(
    @Param('companionId') companionId: string,
    @Param('messageId') messageId: string,
    @Query() query: unknown,
  ): Promise<PublishedMessage> {
    return this.receiving.source(
      parseId(companionId),
      parseId(messageId),
      parseInput(sourceLookupQuerySchema, query),
    );
  }

  /** 查看当前实例的逐条读取与待整理记录，不把查询当作实际取得原文。 */
  @Get('conversations/:id/progress')
  progress(
    @Param('companionId') companionId: string,
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<ConversationProgressResponse> {
    return this.receiving.progress(
      parseId(companionId),
      parseId(id),
      parseInput(companionSequenceQuerySchema, query),
    );
  }

  /** 明确取得当前范围内的完整原文，独立登记读取，不推进整理或终端交付。 */
  @Post('conversations/:id/receive')
  receive(
    @Param('companionId') companionId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ReceiveMessagesResponse> {
    return this.receiving.receive(
      parseId(companionId),
      parseId(id),
      parseInput(receiveMessagesRequestSchema, body),
    );
  }
}
