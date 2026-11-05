import {
  modelConfigurationSchema,
  MODEL_TASK_ROLES,
  modelHardLimitsSchema,
  modelOperationSchema,
} from '@memory-weave/contracts';
import type { ModelConfiguration, ModelHardLimits } from '@memory-weave/contracts';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from '../shared/http';
import { defaultModelConfiguration } from './model-defaults';

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
  /** 文件管理的完整配置；程序化测试夹具可省略，不提供环境变量绕过开关。 */
  file?: {
    /** 实际加载的绝对路径。 */
    path: string;
    /** 配置与非秘密供应商信息的稳定指纹。 */
    fingerprint: string;
    /** 启动后固定使用的完整任务配置。 */
    configuration: ModelConfiguration;
  };
}

/**
 * 创建模型调用的默认部署资源上限。
 *
 * 默认部署上限不会因 HTTP 配置发布而提高。
 */
export function defaultModelHardLimits(): ModelHardLimits {
  return {
    dailyBudget: { requests: 10_000, tokens: 10_000_000, costMicros: 10_000_000 },
    maxConcurrent: 4,
    backgroundConcurrent: 1,
  };
}

/** 模型文件使用完整配置，不提供多层合并或隐藏的数据库覆盖。 */
export const modelFileSchema = z
  .object({
    providers: z.array(providerSchema).max(16),
    hardLimits: modelHardLimitsSchema,
    configuration: modelConfigurationSchema,
  })
  .strict();

/** 模型文件错误只包含字段位置和固定说明，不回显配置值。 */
export class ModelFileError extends Error {}

/** 按启动环境选择文件；显式覆盖必须是绝对路径，避免工作目录歧义。 */
export function modelConfigPath(environment: NodeJS.ProcessEnv): string {
  if (environment.MODEL_CONFIG_FILE) {
    if (!isAbsolute(environment.MODEL_CONFIG_FILE))
      throw new ModelFileError('MODEL_CONFIG_FILE 必须是绝对路径。');
    return environment.MODEL_CONFIG_FILE;
  }
  const mode = environment.NODE_ENV ?? 'development';
  if (!['production', 'development', 'test'].includes(mode))
    throw new ModelFileError('NODE_ENV 必须为 development、production 或 test。');
  return fileURLToPath(
    new URL(
      `../../../../../config/models.${mode === 'production' ? 'production' : 'development'}.json`,
      import.meta.url,
    ),
  );
}

/** 校验完整模型文件并解析密钥引用；不发起外部请求。 */
export function parseModelFile(
  value: unknown,
  environment: NodeJS.ProcessEnv,
  path: string,
): ModelDeployment {
  const parsed = modelFileSchema.safeParse(value);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'root'))];
    throw new ModelFileError(`模型部署配置无效，请检查字段：${fields.join('、')}。`);
  }
  const document = parsed.data;
  const { configuration, hardLimits } = document;
  if (new Set(document.providers.map((provider) => provider.id)).size !== document.providers.length)
    throw new ModelFileError('模型部署配置无效：providers.id 重复。');
  if (
    hardLimits.backgroundConcurrent >= hardLimits.maxConcurrent ||
    configuration.backgroundConcurrent >= configuration.maxConcurrent
  )
    throw new ModelFileError('模型部署配置无效：后台并发必须小于总并发。');
  if (
    configuration.maxConcurrent > hardLimits.maxConcurrent ||
    configuration.backgroundConcurrent > hardLimits.backgroundConcurrent ||
    (['requests', 'tokens', 'costMicros'] as const).some(
      (key) => configuration.dailyBudget[key] > hardLimits.dailyBudget[key],
    )
  )
    throw new ModelFileError('模型部署配置无效：configuration 超过 hardLimits。');
  const providers = document.providers.map((definition) => {
    const key = definition.apiKeyEnv ? environment[definition.apiKeyEnv] : undefined;
    if (key && !/^[\x21-\x7e]{1,4096}$/.test(key))
      throw new ModelFileError('模型部署配置无效：供应商凭据格式错误。');
    return { ...definition, apiKey: key || null };
  });
  const defaults = defaultModelConfiguration();
  for (const role of MODEL_TASK_ROLES) {
    const task = configuration.tasks[role];
    const expected = defaults.tasks[role];
    if (
      task.promptVersion !== expected.promptVersion ||
      task.schemaVersion !== expected.schemaVersion ||
      task.preprocessingVersion !== expected.preprocessingVersion
    )
      throw new ModelFileError(`模型部署配置无效：configuration.tasks.${role} 的任务定义不匹配。`);
    if (
      role === 'embedding'
        ? task.dimensions === null || task.maxOutputTokens !== 0
        : task.dimensions !== null || task.maxOutputTokens === 0
    )
      throw new ModelFileError(
        `模型部署配置无效：configuration.tasks.${role} 的维度或输出上限错误。`,
      );
    if (task.providerId === 'test') continue;
    const provider = providers.find((provider) => provider.id === task.providerId);
    if (!provider)
      throw new ModelFileError(`模型部署配置无效：configuration.tasks.${role}.providerId 未登记。`);
    if (!task.enabled) continue;
    const operation = role === 'embedding' ? 'embedding' : role === 'chat' ? 'text' : 'structured';
    if (!provider.capabilities.includes(operation))
      throw new ModelFileError(
        `模型部署配置无效：configuration.tasks.${role} 的供应商能力不匹配。`,
      );
    if (provider.apiKeyEnv !== null && !provider.apiKey)
      throw new ModelFileError(`模型部署配置无效：configuration.tasks.${role} 缺少供应商凭据。`);
    if (task.inputMicrosPerMillion === null || task.outputMicrosPerMillion === null)
      throw new ModelFileError(`模型部署配置无效：configuration.tasks.${role} 未设置价格。`);
  }
  // 规范化对象字段和供应商顺序；密钥的值不进入指纹和数据库。
  const normalized = {
    ...document,
    providers: [...document.providers].sort((a, b) => a.id.localeCompare(b.id)),
  };
  return {
    providers,
    hardLimits,
    file: { path, fingerprint: fingerprint(normalized), configuration },
  };
}

/** 读取启动时选定的模型文件，拒绝旧环境变量与文件同时成为配置来源。 */
export function loadModelDeployment(environment: NodeJS.ProcessEnv): ModelDeployment {
  for (const key of ['MODEL_PROVIDERS_JSON', 'MODEL_HARD_LIMITS_JSON'])
    if (environment[key] !== undefined)
      throw new ModelFileError(`请将 ${key} 迁入模型 JSON 文件并删除旧环境变量。`);
  const path = modelConfigPath(environment);
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new ModelFileError(
      '模型配置文件缺失或不是有效 JSON，请运行 pnpm setup 或检查 MODEL_CONFIG_FILE。',
    );
  }
  return parseModelFile(document, environment, path);
}
