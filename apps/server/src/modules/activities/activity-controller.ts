import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  activityListQuerySchema,
  activityVersionParamSchema,
  activityVersionQuerySchema,
  createActivitySchema,
  emptyCommandSchema,
  reviseActivitySchema,
  uuidSchema,
} from '@memory-weave/contracts';
import type {
  Activity,
  ActivityList,
  ActivityListQuery,
  ActivityVersionList,
  ActivityVersionQuery,
  CreateActivity,
  EmptyCommand,
  ReviseActivity,
} from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { CurrentOwner } from '../auth/current-owner';
import { ActivityService } from './activity-service';

const activityIdSchema = uuidSchema.transform((id) => id.toLowerCase());

/** 已认证用户可安排活动、修改目标并确认具体版本的成果。 */
@Controller('activities')
export class ActivityController {
  /** 初始化活动接口。 */
  constructor(@Inject(ActivityService) private readonly service: ActivityService) {}

  /** 创建持久的读写委托。 */
  @Post()
  create(
    @CurrentOwner() ownerId: string,
    @Body(new ZodValidationPipe(createActivitySchema)) command: CreateActivity,
  ): Promise<Activity> {
    return this.service.create(ownerId, command);
  }

  /** 按作用域查询活动。 */
  @Get()
  list(
    @CurrentOwner() ownerId: string,
    @Query(new ZodValidationPipe(activityListQuerySchema)) query: ActivityListQuery,
  ): Promise<ActivityList> {
    return this.service.list(ownerId, query);
  }

  /** 读取活动当前版本。 */
  @Get(':id')
  get(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(activityIdSchema)) id: string,
  ): Promise<Activity> {
    return this.service.get(ownerId, id);
  }

  /** 创建新的目标版本。 */
  @Post(':id/revisions')
  @HttpCode(200)
  revise(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(activityIdSchema)) id: string,
    @Body(new ZodValidationPipe(reviseActivitySchema)) command: ReviseActivity,
  ): Promise<Activity> {
    return this.service.revise(ownerId, id, command);
  }

  /** 读取历史目标与成果分页。 */
  @Get(':id/versions')
  versions(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(activityIdSchema)) id: string,
    @Query(new ZodValidationPipe(activityVersionQuerySchema)) query: ActivityVersionQuery,
  ): Promise<ActivityVersionList> {
    return this.service.versions(ownerId, id, query);
  }

  /** 读取指定版本。 */
  @Get(':id/versions/:version')
  version(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(activityIdSchema)) id: string,
    @Param('version', new ZodValidationPipe(activityVersionParamSchema)) version: number,
  ): Promise<Activity> {
    return this.service.get(ownerId, id, version);
  }

  /** 幂等确认已保存的指定成果。 */
  @Post(':id/versions/:version/acknowledge')
  @HttpCode(200)
  acknowledge(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(activityIdSchema)) id: string,
    @Param('version', new ZodValidationPipe(activityVersionParamSchema)) version: number,
    @Body(new ZodValidationPipe(emptyCommandSchema)) _body: EmptyCommand,
  ): Promise<Activity> {
    return this.service.acknowledge(ownerId, id, version);
  }
}
