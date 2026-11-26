import { z } from 'zod';

/** 每实例的常规检查、事件间隔和跨会话的运行额度。 */
export const reflectionConfigurationSchema = z.strictObject({
  enabled: z.boolean().default(true),
  routineIntervalMs: z
    .number()
    .int()
    .min(1000)
    .max(7 * 86400000)
    .default(86400000),
  minimumIntervalMs: z.number().int().min(1000).max(86400000).default(3600000),
  dailyRuns: z.number().int().min(1).max(30).default(2),
  batchEvents: z.number().int().min(1).max(12).default(6),
});
export type ReflectionConfiguration = z.infer<typeof reflectionConfigurationSchema>;
