import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  growthControlQuerySchema,
  growthFreezeSchema,
  growthQuerySchema,
  growthRollbackSchema,
  growthVersionQuerySchema,
  uuidSchema,
} from '@memory-weave/contracts';
import type {
  GrowthFreeze,
  GrowthQuery,
  GrowthRollback,
  GrowthVersionQuery,
} from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { CurrentOwner } from '../auth/current-owner';
import { GrowthService } from './growth-service';

/** 查看成长经过并管理冻结或同代次回退。 */
@Controller('companions/:companionId/growth')
export class GrowthController {
  /** 初始化成长管理入口。 */
  constructor(@Inject(GrowthService) private readonly growth: GrowthService) {}

  /** 获取当前冻结控制和可用版本。 */
  @Get('control')
  control(
    @CurrentOwner() ownerId: string,
    @Param('companionId', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(growthControlQuerySchema)) query: { runtimeEpoch: number },
  ) {
    return this.growth.control(ownerId, id.toLowerCase(), query.runtimeEpoch);
  }

  /** 追加冻结或解冻操作。 */
  @Post('freeze')
  @HttpCode(200)
  freeze(
    @CurrentOwner() ownerId: string,
    @Param('companionId', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(growthFreezeSchema)) command: GrowthFreeze,
  ) {
    return this.growth.freeze(ownerId, id.toLowerCase(), command);
  }

  /** 将目标 L1 版本追加写入当前代次。 */
  @Post('rollback')
  @HttpCode(200)
  rollback(
    @CurrentOwner() ownerId: string,
    @Param('companionId', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(growthRollbackSchema)) command: GrowthRollback,
  ) {
    return this.growth.rollback(ownerId, id.toLowerCase(), command);
  }

  /** 查询模型提案、实际验证和是否提交。 */
  @Get('candidates')
  candidates(
    @CurrentOwner() ownerId: string,
    @Param('companionId', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(growthQuerySchema)) query: GrowthQuery,
  ) {
    return this.growth.candidates(ownerId, id.toLowerCase(), query);
  }

  /** 分页查询当前代次的人格版本。 */
  @Get('versions')
  versions(
    @CurrentOwner() ownerId: string,
    @Param('companionId', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(growthVersionQuerySchema)) query: GrowthVersionQuery,
  ) {
    return this.growth.versions(ownerId, id.toLowerCase(), query);
  }
}
