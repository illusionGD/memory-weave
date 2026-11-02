import { Body, Controller, Get, Inject, Param, Put, Post, HttpCode } from '@nestjs/common';
import {
  versionParamSchema,
  uuidSchema,
  updateModelConfigurationSchema,
  modelProbeSchema,
} from '@memory-weave/contracts';
import type {
  ModelProbe,
  UpdateModelConfiguration,
  ModelConfigurationVersion,
  ModelCall,
  ModelUsage,
} from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { ModelConfigurationService } from './model-configuration.service';
import { ModelRuntimeService } from './model-runtime.service';
import { ModelProvidersService } from './model-providers.service';

/** 当前登录部署的模型管理入口，不提供任意地址或密钥上传。 */
@Controller('models')
export class ModelsController {
  /** 初始化模型管理接口所需的服务。 */
  constructor(
    @Inject(ModelConfigurationService) private readonly configuration: ModelConfigurationService,
    @Inject(ModelRuntimeService) private readonly runtime: ModelRuntimeService,
    @Inject(ModelProvidersService) private readonly providers: ModelProvidersService,
  ) {}

  /**
   * 查询模型供应商能力及部署上限。
   *
   * 查询部署登记的能力与硬上限，不返回凭据。
   */
  @Get('providers')
  getProviders(): ReturnType<ModelProvidersService['catalog']> {
    return this.providers.catalog();
  }

  /**
   * 提交模型诊断请求。
   *
   * 生成隔离诊断结果；失败时也保留真实尝试记录。
   */
  @Post('probes')
  probe(@Body(new ZodValidationPipe(modelProbeSchema)) body: ModelProbe): Promise<ModelCall> {
    return this.runtime.probe(body);
  }

  /**
   * 查询模型调用详情。
   *
   * 当前部署的调用详情，包括每次尝试及用量。
   */
  @Get('calls/:id')
  getCall(@Param('id', new ZodValidationPipe(uuidSchema)) id: string): Promise<ModelCall> {
    return this.runtime.get(id);
  }

  /**
   * 提交模型调用取消请求。
   *
   * 取消逻辑调用，不承诺供应商已停止计算或退回费用。
   */
  @Post('calls/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id', new ZodValidationPipe(uuidSchema)) id: string): Promise<ModelCall> {
    return this.runtime.cancel(id);
  }

  /**
   * 查询当前日期的模型用量。
   *
   * 固定 UTC 日窗口的全局及任务计量。
   */
  @Get('usage')
  getUsage(): Promise<ModelUsage> {
    return this.runtime.usage();
  }

  /** 查询当前生效的模型配置。 */
  @Get('config')
  getConfiguration(): Promise<ModelConfigurationVersion> {
    return this.configuration.get();
  }

  /**
   * 查询指定版本的模型配置。
   *
   * 查询不可变历史配置。
   */
  @Get('config/versions/:version')
  getVersion(
    @Param('version', new ZodValidationPipe(versionParamSchema)) version: number,
  ): Promise<ModelConfigurationVersion> {
    return this.configuration.getVersion(version);
  }

  /**
   * 发布新的模型配置版本。
   *
   * 以乐观版本和幂等键发布完整配置，保留既有用量。
   */
  @Put('config')
  updateConfiguration(
    @Body(new ZodValidationPipe(updateModelConfigurationSchema)) body: UpdateModelConfiguration,
  ): Promise<ModelConfigurationVersion> {
    return this.configuration.update(body);
  }
}
