import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import {
  uuidSchema,
  createPersonaTemplateSchema,
  updatePersonaTemplateSchema,
  idPaginationQuerySchema,
  runtimeEpochQuerySchema,
} from '@memory-weave/contracts';
import type {
  CreatePersonaTemplate,
  UpdatePersonaTemplate,
  IdPaginationQuery,
  PersonaTemplate,
  PersonaTemplateList,
} from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { PersonaTemplatesService } from './persona-templates.service';

/** 已认证部署的人设模板与不可变历史版本。 */
@Controller('persona-templates')
export class PersonaTemplatesController {
  /** 初始化人设模板接口所需的服务。 */
  constructor(
    @Inject(PersonaTemplatesService) private readonly templates: PersonaTemplatesService,
  ) {}

  /** 保存人设模板的首个版本。 */
  @Post()
  create(
    @Body(new ZodValidationPipe(createPersonaTemplateSchema)) body: CreatePersonaTemplate,
  ): Promise<PersonaTemplate> {
    return this.templates.create(body);
  }

  /**
   * 提交人设模板的新版本。
   *
   * 乐观并发编辑，保留全部旧版本。
   */
  @Post(':id/versions')
  update(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(updatePersonaTemplateSchema)) body: UpdatePersonaTemplate,
  ): Promise<PersonaTemplate> {
    return this.templates.update(id, body);
  }

  /** 分页查询人设模板的最新版本。 */
  @Get()
  list(
    @Query(new ZodValidationPipe(idPaginationQuerySchema)) query: IdPaginationQuery,
  ): Promise<PersonaTemplateList> {
    return this.templates.list(query);
  }

  /** 查询人设模板的指定版本。 */
  @Get(':id/versions/:version')
  version(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('version', new ZodValidationPipe(runtimeEpochQuerySchema)) version: number,
  ): Promise<PersonaTemplate> {
    return this.templates.get(id, version);
  }

  /** 查询人设模板的最新版本。 */
  @Get(':id')
  get(@Param('id', new ZodValidationPipe(uuidSchema)) id: string): Promise<PersonaTemplate> {
    return this.templates.get(id);
  }
}
