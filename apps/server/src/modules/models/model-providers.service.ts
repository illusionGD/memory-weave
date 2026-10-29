import { API_CODES } from '@memory-weave/contracts';
import type {
  ModelOperation,
  ModelConfiguration,
  ModelProviderCatalog,
} from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { SERVER_CONFIG } from '../../config';
import type { RuntimeConfig } from '../../config';
import { ApiException } from '../../http/api-exception';
import { DeterministicModelAdapter } from './model-adapter';
import type { ModelAdapter } from './model-adapter';
import { defaultModelHardLimits } from './model-deployment';
import type { ModelDeployment } from './model-deployment';
import { OpenAiCompatibleAdapter } from './openai-compatible.adapter';

/** 供应商由部署层白名单登记，业务配置只能引用现有标识。 */
@Injectable()
export class ModelProvidersService {
  private readonly deployment: ModelDeployment;
  constructor(@Inject(SERVER_CONFIG) config: RuntimeConfig) {
    this.deployment = config.modelDeployment ?? {
      providers: [],
      hardLimits: defaultModelHardLimits(),
    };
  }

  /** 只展示能力和凭据是否就绪，不提供密钥或环境变量值。 */
  catalog(): ModelProviderCatalog {
    return {
      providers: [
        {
          id: 'test',
          kind: 'test',
          capabilities: ['text', 'structured', 'embedding'],
          credentialConfigured: true,
          streaming: true,
          tools: false,
          vision: false,
        },
        ...this.deployment.providers.map((provider) => ({
          id: provider.id,
          kind: 'openai-compatible' as const,
          capabilities: provider.capabilities,
          credentialConfigured: provider.apiKeyEnv === null || provider.apiKey !== null,
          streaming: provider.streaming,
          tools: false as const,
          vision: false as const,
        })),
      ],
      hardLimits: this.deployment.hardLimits,
    };
  }

  /** 发布配置时拒绝未登记的供应商和超部署上限配置；不主动访问供应商。 */
  validate(config: ModelConfiguration): void {
    const effective = this.effective(config);
    if (
      (['requests', 'tokens', 'costMicros'] as const).some(
        (key) => effective.dailyBudget[key] !== config.dailyBudget[key],
      ) ||
      effective.maxConcurrent !== config.maxConcurrent ||
      effective.backgroundConcurrent !== config.backgroundConcurrent
    )
      throw new ApiException(API_CODES.INVALID_REQUEST, '配置不能超过部署资源上限。');
    for (const task of Object.values(config.tasks)) {
      if (
        task.providerId !== 'test' &&
        !this.deployment.providers.some((provider) => provider.id === task.providerId)
      )
        throw new ApiException(API_CODES.MODEL_NOT_CONFIGURED);
    }
  }

  /** 部署限额降低后，已有配置也只使用较小上限，不放宽旧配置。 */
  effective(config: ModelConfiguration): ModelConfiguration {
    const limits = this.deployment.hardLimits;
    return {
      ...config,
      dailyBudget: {
        requests: Math.min(config.dailyBudget.requests, limits.dailyBudget.requests),
        tokens: Math.min(config.dailyBudget.tokens, limits.dailyBudget.tokens),
        costMicros: Math.min(config.dailyBudget.costMicros, limits.dailyBudget.costMicros),
      },
      maxConcurrent: Math.min(config.maxConcurrent, limits.maxConcurrent),
      backgroundConcurrent: Math.min(
        config.backgroundConcurrent,
        limits.backgroundConcurrent,
        Math.min(config.maxConcurrent, limits.maxConcurrent) - 1,
      ),
    };
  }

  /** 检查所需能力和凭据，再取得一次请求 adapter；不静默换模型。 */
  adapter(id: string, operation: ModelOperation): ModelAdapter {
    if (id === 'test') return new DeterministicModelAdapter();
    const provider = this.deployment.providers.find((item) => item.id === id);
    if (
      !provider ||
      !provider.capabilities.includes(operation) ||
      (provider.apiKeyEnv !== null && !provider.apiKey)
    )
      throw new ApiException(API_CODES.MODEL_NOT_CONFIGURED);
    return new OpenAiCompatibleAdapter(provider);
  }

  /** 只按部署声明使用流式协议，不通过额外探测请求消耗预算。 */
  supportsStreaming(id: string): boolean {
    return (
      id === 'test' || this.deployment.providers.some((item) => item.id === id && item.streaming)
    );
  }
}
