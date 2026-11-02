import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { RetrievalIndexService } from './retrieval-index.service';
import { recallQuerySchema, organizeMemorySchema } from '@memory-weave/contracts';
import { parseId, parseInput } from '../shared/http';
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
  @Get('indexes') indexesList(@Param('id') id: string, @Query() value: unknown) {
    const query = parseInput(
      z
        .object({ runtimeEpoch: z.coerce.number().int().positive(), afterId: z.uuid().optional() })
        .strict(),
      value,
    );
    return this.indexes.list(parseId(id), query.runtimeEpoch, query.afterId);
  }
  /**
   * 提交向量索引重试或重建请求。
   *
   * 显式重试已知失败或重建派生点，保留旧尝试和成功编码。
   */
  @Post('indexes/:indexId/retry') retryIndex(
    @Param('id') id: string,
    @Param('indexId') indexId: string,
    @Body() body: unknown,
  ) {
    return this.indexes.retry(
      parseId(id),
      parseId(indexId),
      parseInput(organizeMemorySchema, body),
    );
  }
  /**
   * 查询与输入相关的记忆及新原文。
   *
   * 普通陈述、查询和受限的深度回忆共用入口。
   */
  @Post() recall(@Param('id') id: string, @Body() body: unknown) {
    return this.retrieval.recall(parseId(id), parseInput(recallQuerySchema, body));
  }
}
