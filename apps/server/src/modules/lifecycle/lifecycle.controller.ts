import { CurrentOwner } from '../auth/current-owner';
import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import {
  uuidSchema,
  idPaginationQuerySchema,
  lifecycleCommandSchema,
  retryLifecycleSchema,
} from '@memory-weave/contracts';
import type {
  LifecycleCommand,
  IdPaginationQuery,
  RetryLifecycle,
  LifecycleList,
  LifecycleOperation,
} from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { LifecycleService } from './lifecycle.service';

/** 所有终端共用同一生命周期命令与持久进度。 */
@Controller('lifecycle')
export class LifecycleController {
  /** 初始化生命周期接口所需的服务。 */
  constructor(@Inject(LifecycleService) private readonly service: LifecycleService) {}
  /**
   * 提交生命周期操作并安排清理任务。
   *
   * 保存限制，随后由持久 worker 清理。
   */
  @Post()
  create(
    @CurrentOwner() ownerId: string,
    @Body(new ZodValidationPipe(lifecycleCommandSchema)) input: LifecycleCommand,
  ): Promise<LifecycleOperation> {
    return this.service.create(ownerId, input);
  }
  /** 分页查询生命周期清理记录。 */
  @Get()
  list(
    @CurrentOwner() ownerId: string,
    @Query(new ZodValidationPipe(idPaginationQuerySchema)) query: IdPaginationQuery,
  ): Promise<LifecycleList> {
    return this.service.list(ownerId, query);
  }
  /**
   * 恢复中断的生命周期清理操作。
   *
   * 中断后继续清理，原有限制与范围不变。
   */
  @Post(':id/retry')
  retry(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(retryLifecycleSchema)) input: RetryLifecycle,
  ): Promise<LifecycleOperation> {
    return this.service.retry(ownerId, id, input);
  }
  /** 查询指定生命周期操作的详情。 */
  @Get(':id')
  get(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<LifecycleOperation> {
    return this.service.get(ownerId, id);
  }
}
