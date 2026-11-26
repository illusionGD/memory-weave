import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  reflectionHistoryQuerySchema,
  reflectionQuerySchema,
  reflectionScopeSchema,
  uuidSchema,
} from '@memory-weave/contracts';
import type {
  ReflectionHistoryQuery,
  ReflectionQuery,
  ReflectionScope,
} from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { CurrentOwner } from '../auth/current-owner';
import { ReflectionPlanning } from './reflection-planning';
import { ReflectionService } from './reflection-service';

/** 后台查询真实的反思轮次、采用记录及其来源。 */
@Controller('companions/:companionId/reflections')
export class ReflectionController {
  /** 初始化反思调度与查询。 */
  constructor(
    @Inject(ReflectionPlanning) private readonly planning: ReflectionPlanning,
    @Inject(ReflectionService) private readonly reflections: ReflectionService,
  ) {}

  /** 提前检查新增的真实经历，仍计入当前实例的持久额度。 */
  @Post('run')
  @HttpCode(200)
  start(
    @CurrentOwner() ownerId: string,
    @Param('companionId', new ZodValidationPipe(uuidSchema)) companionId: string,
    @Body(new ZodValidationPipe(reflectionScopeSchema)) scope: ReflectionScope,
  ) {
    return this.planning.start(ownerId, {
      companionId: companionId.toLowerCase(),
      conversationId: scope.conversationId.toLowerCase(),
      runtimeEpoch: scope.runtimeEpoch,
    });
  }

  /** 分页查询轮次及实际采用结果。 */
  @Get()
  runs(
    @CurrentOwner() ownerId: string,
    @Param('companionId', new ZodValidationPipe(uuidSchema)) companionId: string,
    @Query(new ZodValidationPipe(reflectionQuerySchema)) query: ReflectionQuery,
  ) {
    return this.reflections.runs(ownerId, companionId.toLowerCase(), query);
  }

  /** 查询当前认识、自传和观察候选。 */
  @Get('findings')
  findings(
    @CurrentOwner() ownerId: string,
    @Param('companionId', new ZodValidationPipe(uuidSchema)) companionId: string,
    @Query(new ZodValidationPipe(reflectionQuerySchema)) query: ReflectionQuery,
  ) {
    return this.reflections.findings(ownerId, companionId.toLowerCase(), query);
  }

  /** 分页回查同一认识或自传的旧版本。 */
  @Get('findings/:id/versions')
  history(
    @CurrentOwner() ownerId: string,
    @Param('companionId', new ZodValidationPipe(uuidSchema)) companionId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(reflectionHistoryQuerySchema)) query: ReflectionHistoryQuery,
  ) {
    return this.reflections.history(ownerId, companionId.toLowerCase(), id.toLowerCase(), query);
  }
}
