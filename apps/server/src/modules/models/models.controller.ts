import { Body, Controller, Get, Inject, Param, Put, Post, HttpCode } from '@nestjs/common';
import { updateModelConfigurationSchema, modelProbeSchema } from '@memory-weave/contracts';
import type { ModelConfigurationVersion, ModelCall, ModelUsage } from '@memory-weave/contracts';
import { z } from 'zod';
import { parseInput, parseId } from '../shared/http';
import { ModelConfigurationService } from './model-configuration.service';
import { ModelRuntimeService } from './model-runtime.service';
import { ModelProvidersService } from './model-providers.service';

/** 当前登录部署的模型管理入口，不提供任意地址或密钥上传。 */
@Controller('models')
export class ModelsController {
  constructor(
    @Inject(ModelConfigurationService) private readonly configuration: ModelConfigurationService,
    @Inject(ModelRuntimeService) private readonly runtime: ModelRuntimeService,
    @Inject(ModelProvidersService) private readonly providers: ModelProvidersService,
  ) {}

  /** 查询部署登记的能力与硬上限，不返回凭据。 */
  @Get('providers')
  getProviders(): ReturnType<ModelProvidersService['catalog']> {
    return this.providers.catalog();
  }

  /** 生成隔离诊断结果；失败时也保留真实尝试记录。 */
  @Post('probes')
  probe(@Body() body: unknown): Promise<ModelCall> {
    return this.runtime.probe(parseInput(modelProbeSchema, body));
  }

  /** 当前部署的调用详情，包括每次尝试及用量。 */
  @Get('calls/:id')
  getCall(@Param('id') id: string): Promise<ModelCall> {
    return this.runtime.get(parseId(id));
  }

  /** 取消逻辑调用，不承诺供应商已停止计算或退回费用。 */
  @Post('calls/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string): Promise<ModelCall> {
    return this.runtime.cancel(parseId(id));
  }

  /** 固定 UTC 日窗口的全局及任务计量。 */
  @Get('usage')
  getUsage(): Promise<ModelUsage> {
    return this.runtime.usage();
  }

  /** 读取当前生效版本及完整配置。 */
  @Get('config')
  getConfiguration(): Promise<ModelConfigurationVersion> {
    return this.configuration.get();
  }

  /** 查询不可变历史配置。 */
  @Get('config/versions/:version')
  getVersion(@Param('version') version: string): Promise<ModelConfigurationVersion> {
    return this.configuration.getVersion(
      parseInput(
        z
          .string()
          .regex(/^[1-9]\d*$/)
          .transform(Number)
          .pipe(z.number().int().max(2_147_483_647)),
        version,
      ),
    );
  }

  /** 以乐观版本和幂等键发布完整配置，保留既有用量。 */
  @Put('config')
  updateConfiguration(@Body() body: unknown): Promise<ModelConfigurationVersion> {
    return this.configuration.update(parseInput(updateModelConfigurationSchema, body));
  }
}
