import { CurrentOwner } from '../auth/current-owner';
import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import {
  uuidSchema,
  createCompanionRequestSchema,
  idPaginationQuerySchema,
} from '@memory-weave/contracts';
import type {
  CreateCompanionRequest,
  IdPaginationQuery,
  CompanionDetail,
  CompanionListResponse,
} from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { CompanionsService } from './companions.service';

/** 管理当前部署的伴侣实例，沿用默认登录认证。 */
@Controller('companions')
export class CompanionsController {
  /** 初始化伴侣实例接口所需的服务。 */
  constructor(@Inject(CompanionsService) private readonly companions: CompanionsService) {}

  /**
   * 创建伴侣实例及其初始人格记录。
   *
   * 创建实例及独立保存的初始、当前人格版本。
   */
  @Post()
  create(
    @CurrentOwner() ownerId: string,
    @Body(new ZodValidationPipe(createCompanionRequestSchema)) body: CreateCompanionRequest,
  ): Promise<CompanionDetail> {
    return this.companions.create(ownerId, body);
  }

  /**
   * 分页查询当前部署的伴侣实例。
   *
   * 使用稳定 UUID 游标分页读取当前部署的实例。
   */
  @Get()
  list(
    @CurrentOwner() ownerId: string,
    @Query(new ZodValidationPipe(idPaginationQuerySchema)) query: IdPaginationQuery,
  ): Promise<CompanionListResponse> {
    return this.companions.list(ownerId, query);
  }

  /** 查询伴侣实例详情。 */
  @Get(':id')
  get(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<CompanionDetail> {
    return this.companions.get(ownerId, id);
  }
}
