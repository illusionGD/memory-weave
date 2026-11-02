import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import {
  recallIndexQuerySchema,
  uuidSchema,
  recallQuerySchema,
  organizeMemorySchema,
} from '@memory-weave/contracts';
import type { RecallIndexQuery, OrganizeMemory, RecallQuery } from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { RetrievalIndexService } from './retrieval-index.service';
import { RetrievalService } from './retrieval.service';

/** 所有终端复用同一检索范围与覆盖语义。 */
@Controller('companions/:id/recall')
export class RetrievalController {
  /** 初始化记忆检索接口所需的服务。 */
  constructor(
    @Inject(RetrievalService) private readonly retrieval: RetrievalService,
    @Inject(RetrievalIndexService) private readonly indexes: RetrievalIndexService,
  ) {}
  /** 分页查询当前编码空间的索引状态。 */
  @Get('indexes') indexesList(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(recallIndexQuerySchema)) query: RecallIndexQuery,
  ) {
    return this.indexes.list(id, query.runtimeEpoch, query.afterId);
  }
  /**
   * 提交向量索引重试或重建请求。
   *
   * 显式重试已知失败或重建派生点，保留旧尝试和成功编码。
   */
  @Post('indexes/:indexId/retry') retryIndex(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('indexId', new ZodValidationPipe(uuidSchema)) indexId: string,
    @Body(new ZodValidationPipe(organizeMemorySchema)) body: OrganizeMemory,
  ) {
    return this.indexes.retry(id, indexId, body);
  }
  /**
   * 查询与输入相关的记忆及新原文。
   *
   * 普通陈述、查询和受限的深度回忆共用入口。
   */
  @Post() recall(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(recallQuerySchema)) body: RecallQuery,
  ) {
    return this.retrieval.recall(id, body);
  }
}
