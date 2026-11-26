import { Body, Controller, Get, Inject, Param, Put, Query } from '@nestjs/common';
import {
  administrationCallsQuerySchema,
  changeMemoryPinSchema,
  runtimeEpochQuerySchema,
  idPaginationQuerySchema,
  uuidSchema,
} from '@memory-weave/contracts';
import type {
  AdministrationCallsQuery,
  ChangeMemoryPin,
  IdPaginationQuery,
} from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { CurrentOwner } from '../auth/current-owner';
import { ChatsService } from '../chats/chats.service';
import { MemoryPinService } from './memory-pin.service';
import { AdministrationConfig } from './administration-config';
import { AdministrationObservations } from './administration-observations';

/** 管理端复用业务接口更新状态，从同一来源聚合诊断。 */
@Controller('management')
export class AdministrationController {
  /** 初始化管理只读诊断入口。 */
  constructor(
    @Inject(AdministrationConfig) private readonly config: AdministrationConfig,
    @Inject(AdministrationObservations) private readonly observation: AdministrationObservations,
    @Inject(ChatsService) private readonly chats: ChatsService,
    @Inject(MemoryPinService) private readonly pins: MemoryPinService,
  ) {}

  /** 查看部署有效配置、作用域、版本和实际修改入口。 */
  @Get('configuration')
  configuration(@CurrentOwner() ownerId: string) {
    return this.config.read(ownerId);
  }

  /** 查看已登记的调用以及实际尝试与费用。 */
  @Get('model-calls')
  calls(
    @CurrentOwner() ownerId: string,
    @Query(new ZodValidationPipe(administrationCallsQuerySchema)) query: AdministrationCallsQuery,
  ) {
    return this.observation.calls(ownerId, query);
  }

  /** 根据历史轮次查看确切输入和使用的任务配置。 */
  @Get('chats/:id/runs/:runId')
  chatRun(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('runId', new ZodValidationPipe(uuidSchema)) runId: string,
  ) {
    return this.chats.getRun(ownerId, id.toLowerCase(), runId.toLowerCase());
  }

  /** 查看发布消息的读取、整理和真实终端回执。 */
  @Get('conversations/:id/messages/:messageId')
  message(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('messageId', new ZodValidationPipe(uuidSchema)) messageId: string,
    @Query(new ZodValidationPipe(idPaginationQuerySchema)) query: IdPaginationQuery,
  ) {
    return this.observation.message(ownerId, id.toLowerCase(), messageId.toLowerCase(), query);
  }

  /** 查看明确选择的生命周期范围和实际传播进度。 */
  @Get('lifecycle/:id')
  deletion(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(idPaginationQuerySchema)) query: IdPaginationQuery,
  ) {
    return this.observation.deletion(ownerId, id.toLowerCase(), query);
  }

  /** 查看固定状态。 */
  @Get('companions/:id/memories/:memoryId/pin')
  pin(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('memoryId', new ZodValidationPipe(uuidSchema)) memoryId: string,
    @Query('runtimeEpoch', new ZodValidationPipe(runtimeEpochQuerySchema)) epoch: number,
  ) {
    return this.pins.get(ownerId, id.toLowerCase(), memoryId.toLowerCase(), epoch);
  }

  /** 更新固定状态与并发版本。 */
  @Put('companions/:id/memories/:memoryId/pin')
  changePin(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('memoryId', new ZodValidationPipe(uuidSchema)) memoryId: string,
    @Body(new ZodValidationPipe(changeMemoryPinSchema)) command: ChangeMemoryPin,
  ) {
    return this.pins.change(ownerId, id.toLowerCase(), memoryId.toLowerCase(), command);
  }
}
