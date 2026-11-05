import { CurrentOwner } from '../auth/current-owner';
import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { uuidSchema, memoryQuerySchema, organizeMemorySchema } from '@memory-weave/contracts';
import type { MemoryQuery, OrganizeMemory } from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { MemoriesService } from './memories.service';

/** 受当前实例、代次及会话可见性约束的记忆管理入口。 */
@Controller('companions/:id/memories')
export class MemoriesController {
  /** 初始化记忆整理接口所需的服务。 */
  constructor(@Inject(MemoriesService) private readonly memories: MemoriesService) {}
  /** 分页查询已保存的记忆。 */
  @Get() list(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(memoryQuerySchema)) query: MemoryQuery,
  ) {
    return this.memories.list(ownerId, id, query);
  }
  /** 查询记忆整理批次及执行状态。 */
  @Get('batches') batches(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(memoryQuerySchema)) query: MemoryQuery,
  ) {
    return this.memories.batches(ownerId, id, query);
  }
  /**
   * 查询记忆详情、历史版本和来源。
   *
   * 回查版本和精确来源。
   */
  @Get(':memoryId') detail(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('memoryId', new ZodValidationPipe(uuidSchema)) memoryId: string,
    @Query(new ZodValidationPipe(memoryQuerySchema)) query: MemoryQuery,
  ) {
    return this.memories.detail(ownerId, id, memoryId, query);
  }
  /**
   * 重试指定的记忆整理批次。
   *
   * 对已知失败创建新批次，未知外部结果不能重发。
   */
  @Post('batches/:batchId/retry') retry(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('batchId', new ZodValidationPipe(uuidSchema)) batchId: string,
    @Body(new ZodValidationPipe(organizeMemorySchema)) body: OrganizeMemory,
  ) {
    return this.memories.retry(ownerId, id, batchId, body);
  }
  /** 分页查询记忆版本的精确证据。 */
  @Get(':memoryId/versions/:versionId/evidence') evidence(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('memoryId', new ZodValidationPipe(uuidSchema)) memoryId: string,
    @Param('versionId', new ZodValidationPipe(uuidSchema)) versionId: string,
    @Query(new ZodValidationPipe(memoryQuerySchema)) query: MemoryQuery,
  ) {
    return this.memories.evidence(ownerId, id, memoryId, versionId, query);
  }
  /** 提交会话记忆整理请求。 */
  @Post('organize') organize(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(organizeMemorySchema)) body: OrganizeMemory,
  ) {
    return this.memories.organize(ownerId, id, body);
  }
}
