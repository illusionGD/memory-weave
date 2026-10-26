import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { createCompanionRequestSchema, idPaginationQuerySchema } from '@memory-weave/contracts';
import type { CompanionDetail, CompanionListResponse } from '@memory-weave/contracts';
import { parseId, parseInput } from '../shared/http';
import { CompanionsService } from './companions.service';

/** 管理当前部署的伴侣实例，沿用默认登录认证。 */
@Controller('companions')
export class CompanionsController {
  constructor(@Inject(CompanionsService) private readonly companions: CompanionsService) {}

  /** 创建实例及独立保存的初始、当前人格版本。 */
  @Post()
  create(@Body() body: unknown): Promise<CompanionDetail> {
    return this.companions.create(parseInput(createCompanionRequestSchema, body));
  }

  /** 使用稳定 UUID 游标分页读取当前部署的实例。 */
  @Get()
  list(@Query() query: unknown): Promise<CompanionListResponse> {
    return this.companions.list(parseInput(idPaginationQuerySchema, query));
  }

  /** 读取当前部署内的实例详情。 */
  @Get(':id')
  get(@Param('id') id: string): Promise<CompanionDetail> {
    return this.companions.get(parseId(id));
  }
}
