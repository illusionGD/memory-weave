import { modelHardLimitsSchema, modelOperationSchema } from '@memory-weave/contracts';
import type { ModelHardLimits } from '@memory-weave/contracts';
import { z } from 'zod';

const providerSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,47}$/)
      .refine((id) => id !== 'test'),
    baseUrl: z
      .string()
      .url()
      .transform((value) => {
        const url = new URL(value);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error('Invalid model endpoint');
        return url.toString().replace(/\/+$/, '');
      }),
    apiKeyEnv: z
      .string()
      .regex(/^MODEL_[A-Z0-9_]+$/)
      .nullable(),
    capabilities: z.array(modelOperationSchema).min(1).max(3),
    streaming: z.boolean().default(false),
    outputTokenParameter: z
      .enum(['max_completion_tokens', 'max_tokens'])
      .default('max_completion_tokens'),
    structuredFormat: z.enum(['json_schema', 'json_object']).default('json_schema'),
    sendEmbeddingDimensions: z.boolean().default(true),
  })
  .strict();

/** 只在后端部署配置中持有的供应商信息；凭据不得进入公共配置或诊断。 */
export type ModelProvider = z.infer<typeof providerSchema> & {
  /** 从指定环境变量解析的凭据，仅用于发送请求。 */
  apiKey: string | null;
};

/** 模型部署配置与可版本化的普通任务配置分别保存。 */
export interface ModelDeployment {
  /** 明确登记的外部供应商，不从客户端参数或模型输出取得地址。 */
  providers: ModelProvider[];
  /** 重新部署才能调整的资源上限。 */
  hardLimits: ModelHardLimits;
}

/** 默认部署上限不会因 HTTP 配置发布而提高。 */
export function defaultModelHardLimits(): ModelHardLimits {
  return {
    dailyBudget: { requests: 10_000, tokens: 10_000_000, costMicros: 10_000_000 },
    maxConcurrent: 4,
    backgroundConcurrent: 1,
  };
}

/**
 * 读取供应商及凭据引用；返回值只能留在服务端，错误由启动配置层统一脱敏。
 * @param environment 部署环境变量，不记录原值。
 * @returns 校验过的供应商与不可被普通配置覆盖的资源上限。
 */
export function loadModelDeployment(environment: NodeJS.ProcessEnv): ModelDeployment {
  const definitions = z
    .array(providerSchema)
    .max(16)
    .parse(JSON.parse(environment.MODEL_PROVIDERS_JSON ?? '[]') as unknown);
  if (new Set(definitions.map((item) => item.id)).size !== definitions.length)
    throw new Error('Duplicate model provider');
  const providers = definitions.map((definition) => {
    const key = definition.apiKeyEnv ? environment[definition.apiKeyEnv] : undefined;
    if (key && !/^[\x21-\x7e]{1,4096}$/.test(key)) throw new Error('Invalid model credential');
    return { ...definition, apiKey: key || null };
  });
  const hardLimits = modelHardLimitsSchema.parse(
    environment.MODEL_HARD_LIMITS_JSON
      ? (JSON.parse(environment.MODEL_HARD_LIMITS_JSON) as unknown)
      : defaultModelHardLimits(),
  );
  if (hardLimits.backgroundConcurrent >= hardLimits.maxConcurrent)
    throw new Error('Invalid model concurrency');
  return { providers, hardLimits };
}
