import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import {
  runtimeEpochQuerySchema,
  switchEmbeddingSchema,
  uuidSchema,
} from '@memory-weave/contracts';
import type { SwitchEmbedding } from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { CurrentOwner } from '../auth/current-owner';
import { EmbeddingSpaces } from './embedding-spaces';
import { MemoryMaintenanceService } from './memory-maintenance.service';

/** 管理实际查询版本，回查旧经历的准确来源。 */
@Controller()
export class MemoryMaintenanceController {
  /** 初始化安全切换和归档记录入口。 */
  constructor(
    @Inject(EmbeddingSpaces) private readonly spaces: EmbeddingSpaces,
    @Inject(MemoryMaintenanceService) private readonly maintenance: MemoryMaintenanceService,
  ) {}

  /** 查询活动、构建和回滚空间当前的数据库覆盖。 */
  @Get('retrieval/embedding-spaces')
  embeddings(@CurrentOwner() ownerId: string) {
    return this.spaces.status(ownerId);
  }

  /** 验证覆盖和删除同步后成套切换查询配置。 */
  @Post('retrieval/embedding-spaces/switch')
  switch(
    @CurrentOwner() ownerId: string,
    @Body(new ZodValidationPipe(switchEmbeddingSchema)) command: SwitchEmbedding,
  ) {
    return this.spaces.switch(ownerId, command);
  }

  /** 查询单条经历已经提交的分层建议。 */
  @Get('companions/:id/memories/:memoryId/maintenance')
  view(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('memoryId', new ZodValidationPipe(uuidSchema)) memoryId: string,
    @Query('runtimeEpoch', new ZodValidationPipe(runtimeEpochQuerySchema)) epoch: number,
  ) {
    return this.maintenance.view(ownerId, id.toLowerCase(), epoch, memoryId.toLowerCase());
  }
}
