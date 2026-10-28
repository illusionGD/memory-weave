import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import {
  companionCreationSchema,
  runtimeEpochQuerySchema,
  revisePersonaLocksSchema,
  initializePersonaSchema,
} from '@memory-weave/contracts';
import type { CompanionPersonaState, PersonaVersion } from '@memory-weave/contracts';
import { parseId, parseInput } from '../shared/http';
import { CompanionPersonasService } from './companion-personas.service';

/** 自然语言创建及初始、当前人格查询。 */
@Controller()
export class CompanionPersonasController {
  constructor(
    @Inject(CompanionPersonasService) private readonly personas: CompanionPersonasService,
  ) {}

  /** 保存原稿并安排自动整理。 */
  @Post('companion-creations')
  create(@Body() body: unknown): Promise<CompanionPersonaState> {
    return this.personas.create(parseInput(companionCreationSchema, body));
  }

  /** 查询当前与初始人格及后台任务。 */
  @Get('companions/:id/persona')
  get(@Param('id') id: string): Promise<CompanionPersonaState> {
    return this.personas.get(parseId(id));
  }

  /** 可选的约束修订；自动整理不依赖此操作。 */
  @Post('companions/:id/persona/locks')
  reviseLocks(@Param('id') id: string, @Body() body: unknown): Promise<PersonaVersion> {
    return this.personas.reviseLocks(parseId(id), parseInput(revisePersonaLocksSchema, body));
  }

  /** 旧原稿或已知失败的整理，由管理者显式开始。 */
  @Post('companions/:id/persona/initialize')
  initialize(@Param('id') id: string, @Body() body: unknown): Promise<CompanionPersonaState> {
    return this.personas.initialize(parseId(id), parseInput(initializePersonaSchema, body));
  }

  /** 查询不可变历史版本，运行代次必须明确提供。 */
  @Get('companions/:id/persona/versions/:version')
  version(
    @Param('id') id: string,
    @Param('version') version: string,
    @Query('runtimeEpoch') epoch: unknown,
  ): Promise<PersonaVersion> {
    return this.personas.version(
      parseId(id),
      parseInput(runtimeEpochQuerySchema, epoch),
      parseInput(runtimeEpochQuerySchema, version),
    );
  }
}
