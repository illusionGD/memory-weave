import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import {
  autonomyQuerySchema,
  configureAutonomySchema,
  emptyCommandSchema,
  idPaginationQuerySchema,
  runtimeEpochQuerySchema,
  uuidSchema,
} from '@memory-weave/contracts';
import type {
  AutonomyQuery,
  ConfigureAutonomy,
  EmptyCommand,
  IdPaginationQuery,
} from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { CurrentOwner } from '../auth/current-owner';
import { AutonomyContacts } from './autonomy-contacts';
import { AutonomyService } from './autonomy-service';

/** 用户控制自主权限，查看实际成果及跨实例的主动联系。 */
@Controller()
export class AutonomyController {
  /** 初始化自主权限和主动联系查询。 */
  constructor(
    @Inject(AutonomyService) private readonly autonomy: AutonomyService,
    @Inject(AutonomyContacts) private readonly contacts: AutonomyContacts,
  ) {}

  /** 查看实际授权，首次尚未启用返回空值。 */
  @Get('companions/:id/autonomy')
  settings(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query('runtimeEpoch', new ZodValidationPipe(runtimeEpochQuerySchema)) epoch: number,
  ) {
    return this.autonomy.settings(ownerId, id.toLowerCase(), epoch);
  }

  /** 更新指定实际会话的自主授权和主动联系许可。 */
  @Put('companions/:id/autonomy')
  configure(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(configureAutonomySchema)) command: ConfigureAutonomy,
  ) {
    return this.autonomy.configure(ownerId, id.toLowerCase(), command);
  }

  /** 分页查询持续目标、静默结果和联系意向。 */
  @Get('companions/:id/autonomy/opportunities')
  opportunities(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(autonomyQuerySchema)) query: AutonomyQuery,
  ) {
    return this.autonomy.opportunities(ownerId, id.toLowerCase(), query);
  }

  /** 查询账号级联系意向及实际发布状态。 */
  @Get('autonomy/contacts')
  listContacts(
    @CurrentOwner() ownerId: string,
    @Query(new ZodValidationPipe(idPaginationQuerySchema)) query: IdPaginationQuery,
  ) {
    return this.contacts.list(ownerId, query);
  }

  /** 确认已发布的联系，未发布的意向不能交付。 */
  @Post('autonomy/contacts/:id/acknowledge')
  @HttpCode(200)
  acknowledge(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(emptyCommandSchema)) _body: EmptyCommand,
  ) {
    return this.contacts.acknowledge(ownerId, id.toLowerCase());
  }
}
