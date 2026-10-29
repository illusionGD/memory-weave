import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { memoryQuerySchema, organizeMemorySchema } from '@memory-weave/contracts';
import { parseId, parseInput } from '../shared/http';
import { MemoriesService } from './memories.service';

/** 受当前实例、代次及会话可见性约束的记忆管理入口。 */
@Controller('companions/:id/memories')
export class MemoriesController {
  constructor(@Inject(MemoriesService) private readonly memories: MemoriesService) {}
  /** 查询已采用的记忆。 */
  @Get() list(@Param('id') id: string, @Query() query: unknown) {
    return this.memories.list(parseId(id), parseInput(memoryQuerySchema, query));
  }
  /** 查询批次、模型任务状态及整理参数。 */
  @Get('batches') batches(@Param('id') id: string, @Query() query: unknown) {
    return this.memories.batches(parseId(id), parseInput(memoryQuerySchema, query));
  }
  /** 回查版本和精确来源。 */
  @Get(':memoryId') detail(
    @Param('id') id: string,
    @Param('memoryId') memoryId: string,
    @Query() query: unknown,
  ) {
    return this.memories.detail(
      parseId(id),
      parseId(memoryId),
      parseInput(memoryQuerySchema, query),
    );
  }
  /** 对已知失败创建新批次，未知外部结果不能重发。 */
  @Post('batches/:batchId/retry') retry(
    @Param('id') id: string,
    @Param('batchId') batchId: string,
    @Body() body: unknown,
  ) {
    return this.memories.retry(
      parseId(id),
      parseId(batchId),
      parseInput(organizeMemorySchema, body),
    );
  }
  /** 精确证据分页。 */
  @Get(':memoryId/versions/:versionId/evidence') evidence(
    @Param('id') id: string,
    @Param('memoryId') memoryId: string,
    @Param('versionId') versionId: string,
    @Query() query: unknown,
  ) {
    return this.memories.evidence(
      parseId(id),
      parseId(memoryId),
      parseId(versionId),
      parseInput(memoryQuerySchema, query),
    );
  }
  /** 提前唤醒一个批次。 */
  @Post('organize') organize(@Param('id') id: string, @Body() body: unknown) {
    return this.memories.organize(parseId(id), parseInput(organizeMemorySchema, body));
  }
}
