import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import {
  uuidSchema,
  companionCreationSchema,
  runtimeEpochQuerySchema,
  revisePersonaLocksSchema,
  initializePersonaSchema,
} from '@memory-weave/contracts';
import type {
  CompanionCreation,
  RevisePersonaLocks,
  InitializePersona,
  CompanionPersonaState,
  PersonaVersion,
} from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { CompanionPersonasService } from './companion-personas.service';

/** 自然语言创建及初始、当前人格查询。 */
@Controller()
export class CompanionPersonasController {
  /** 初始化伴侣人格接口所需的服务。 */
  constructor(
    @Inject(CompanionPersonasService) private readonly personas: CompanionPersonasService,
  ) {}

  /**
   * 保存伴侣原稿并安排初始人格整理。
   *
   * 保存原稿并安排自动整理。
   */
  @Post('companion-creations')
  create(
    @Body(new ZodValidationPipe(companionCreationSchema)) body: CompanionCreation,
  ): Promise<CompanionPersonaState> {
    return this.personas.create(body);
  }

  /**
   * 查询伴侣的初始人格、当前人格和整理任务。
   *
   * 查询当前与初始人格及后台任务。
   */
  @Get('companions/:id/persona')
  get(@Param('id', new ZodValidationPipe(uuidSchema)) id: string): Promise<CompanionPersonaState> {
    return this.personas.get(id);
  }

  /**
   * 提交伴侣的长期约束修订。
   *
   * 可选的约束修订；自动整理不依赖此操作。
   */
  @Post('companions/:id/persona/locks')
  reviseLocks(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(revisePersonaLocksSchema)) body: RevisePersonaLocks,
  ): Promise<PersonaVersion> {
    return this.personas.reviseLocks(id, body);
  }

  /**
   * 启动或重试伴侣的初始人格整理。
   *
   * 旧原稿或已知失败的整理，由管理者显式开始。
   */
  @Post('companions/:id/persona/initialize')
  initialize(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(initializePersonaSchema)) body: InitializePersona,
  ): Promise<CompanionPersonaState> {
    return this.personas.initialize(id, body);
  }

  /**
   * 查询指定的人格历史版本。
   *
   * 查询不可变历史版本，运行代次必须明确提供。
   */
  @Get('companions/:id/persona/versions/:version')
  version(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('version', new ZodValidationPipe(runtimeEpochQuerySchema)) version: number,
    @Query('runtimeEpoch', new ZodValidationPipe(runtimeEpochQuerySchema)) epoch: number,
  ): Promise<PersonaVersion> {
    return this.personas.version(id, epoch, version);
  }
}
