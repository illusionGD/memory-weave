import { loadServerConfig as loadInfrastructure } from '../../src/config';
import { modelFileSchema, defaultModelHardLimits } from '../../src/modules/models/model-deployment';

/** 为既有调用/预算故障测试注入可变配置；实际启动入口只能加载 JSON 文件。 */
export function loadServerConfig(environment: NodeJS.ProcessEnv) {
  const providers = modelFileSchema.shape.providers
    .parse(JSON.parse(environment.MODEL_PROVIDERS_JSON ?? '[]') as unknown)
    .map((provider) => ({
      ...provider,
      apiKey: provider.apiKeyEnv ? (environment[provider.apiKeyEnv] ?? null) : null,
    }));
  const hardLimits = modelFileSchema.shape.hardLimits.parse(
    environment.MODEL_HARD_LIMITS_JSON
      ? (JSON.parse(environment.MODEL_HARD_LIMITS_JSON) as unknown)
      : defaultModelHardLimits(),
  );
  return {
    ...loadInfrastructure(environment, { loadModels: false }),
    modelDeployment: { providers, hardLimits },
  };
}
