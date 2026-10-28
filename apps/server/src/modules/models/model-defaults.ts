import { MODEL_TASK_ROLES } from '@memory-weave/contracts';
import type { ModelConfiguration, ModelTaskConfig } from '@memory-weave/contracts';
import { PERSONA_DEFINITION_VERSION } from '../companions/persona-definition';

/** 首次使用时保存一份独立默认值；测试供应商不代表真实模型能力。 */
export function defaultModelConfiguration(): ModelConfiguration {
  const tasks = Object.fromEntries(
    MODEL_TASK_ROLES.map((role) => [
      role,
      {
        enabled: true,
        providerId: 'test',
        model: role === 'embedding' ? 'test-embedding-v1' : 'test-generation-v1',
        promptVersion: role === 'persona' ? PERSONA_DEFINITION_VERSION : 'probe-v1',
        preprocessingVersion: 'utf8-v1',
        schemaVersion:
          role === 'persona'
            ? PERSONA_DEFINITION_VERSION
            : role === 'embedding'
              ? 'vector-v1'
              : 'probe-v1',
        maxInputTokens: role === 'persona' ? 32768 : 8192,
        maxOutputTokens: role === 'embedding' ? 0 : role === 'persona' ? 4096 : 512,
        timeoutMs: 30_000,
        maxAttempts: 1,
        retryDelayMs: 250,
        temperature: null,
        dimensions: role === 'embedding' ? 4 : null,
        inputMicrosPerMillion: null,
        outputMicrosPerMillion: null,
        dailyBudget: { requests: 100, tokens: 100_000, costMicros: 1_000_000 },
      } satisfies ModelTaskConfig,
    ]),
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
