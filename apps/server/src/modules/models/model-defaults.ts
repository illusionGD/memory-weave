import {
  MODEL_PROBE_DEFINITION_VERSION,
  MODEL_VECTOR_SCHEMA_VERSION,
  MODEL_PREPROCESSING_VERSION,
} from './model-constants';
import { MEMORY_DEFINITION_VERSION } from '../memories/memory-definition';
import { MODEL_TASK_ROLES } from '@memory-weave/contracts';
import type { ModelConfiguration, ModelTaskConfig, ModelTaskRole } from '@memory-weave/contracts';
import { PERSONA_DEFINITION_VERSION } from '../companions/persona-definition';
import { CHAT_DEFINITION_VERSION } from '../chats/chat-definition';

/** 各用途的定义与上下文额度；未列出的用途使用诊断默认值。 */
const taskDefaults: Partial<
  Record<ModelTaskRole, { definition: string; input: number; output: number }>
> = {
  chat: { definition: CHAT_DEFINITION_VERSION, input: 32768, output: 512 },
  persona: { definition: PERSONA_DEFINITION_VERSION, input: 32768, output: 4096 },
  memory: { definition: MEMORY_DEFINITION_VERSION, input: 32768, output: 4096 },
  embedding: { definition: MODEL_PROBE_DEFINITION_VERSION, input: 8192, output: 0 },
};
const diagnosticDefaults = { definition: MODEL_PROBE_DEFINITION_VERSION, input: 8192, output: 512 };

/**
 * 创建默认模型配置。
 *
 * 首次使用时保存一份独立默认值；测试供应商不代表真实模型能力。
 */
export function defaultModelConfiguration(): ModelConfiguration {
  const tasks = Object.fromEntries(
    MODEL_TASK_ROLES.map((role) => {
      const defaults = taskDefaults[role] ?? diagnosticDefaults;
      const embedding = role === 'embedding';
      return [
        role,
        {
          enabled: true,
          providerId: 'test',
          model: embedding ? 'test-embedding-v1' : 'test-generation-v1',
          promptVersion: defaults.definition,
          preprocessingVersion: MODEL_PREPROCESSING_VERSION,
          schemaVersion: embedding ? MODEL_VECTOR_SCHEMA_VERSION : defaults.definition,
          maxInputTokens: defaults.input,
          maxOutputTokens: defaults.output,
          timeoutMs: 30_000,
          maxAttempts: 1,
          retryDelayMs: 250,
          temperature: null,
          dimensions: embedding ? 4 : null,
          inputMicrosPerMillion: null,
          outputMicrosPerMillion: null,
          dailyBudget: { requests: 100, tokens: 100_000, costMicros: 1_000_000 },
        } satisfies ModelTaskConfig,
      ];
    }),
  ) as ModelConfiguration['tasks'];
  return {
    currency: 'USD',
    window: 'utc_day',
    dailyBudget: { requests: 1000, tokens: 1_000_000, costMicros: 1_000_000 },
    maxConcurrent: 2,
    backgroundConcurrent: 1,
    tasks,
  };
}
