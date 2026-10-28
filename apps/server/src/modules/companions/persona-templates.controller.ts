import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import {
  createPersonaTemplateSchema,
  updatePersonaTemplateSchema,
  idPaginationQuerySchema,
  runtimeEpochQuerySchema,
} from '@memory-weave/contracts';
import type { PersonaTemplate, PersonaTemplateList } from '@memory-weave/contracts';
import { parseId, parseInput } from '../shared/http';
import { PersonaTemplatesService } from './persona-templates.service';

/** 已认证部署的人设模板与不可变历史版本。 */
@Controller('persona-templates')
export class PersonaTemplatesController {
  constructor(
    @Inject(PersonaTemplatesService) private readonly templates: PersonaTemplatesService,
  ) {}

  /** 保存模板首版。 */
  @Post()
  create(@Body() body: unknown): Promise<PersonaTemplate> {
    return this.templates.create(parseInput(createPersonaTemplateSchema, body));
  }

  /** 乐观并发编辑，保留全部旧版本。 */
  @Post(':id/versions')
  update(@Param('id') id: string, @Body() body: unknown): Promise<PersonaTemplate> {
    return this.templates.update(parseId(id), parseInput(updatePersonaTemplateSchema, body));
  }

  /** 查询模板最新版本列表。 */
  @Get()
  list(@Query() query: unknown): Promise<PersonaTemplateList> {
    return this.templates.list(parseInput(idPaginationQuerySchema, query));
  }

  /** 查询指定版本。 */
  @Get(':id/versions/:version')
  version(@Param('id') id: string, @Param('version') version: string): Promise<PersonaTemplate> {
    return this.templates.get(parseId(id), parseInput(runtimeEpochQuerySchema, version));
  }

  /** 查询模板最新版本。 */
  @Get(':id')
  get(@Param('id') id: string): Promise<PersonaTemplate> {
    return this.templates.get(parseId(id));
  }
}
