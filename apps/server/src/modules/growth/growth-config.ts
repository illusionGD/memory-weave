import { z } from 'zod';

/** 成长评估与追加采用的部署节奏。 */
export const growthConfigurationSchema = z.strictObject({
  enabled: z.boolean().default(true),
  minimumAdoptionIntervalMs: z
    .number()
    .int()
    .min(1000)
    .max(30 * 86400000)
    .default(86400000),
});
export type GrowthConfiguration = z.infer<typeof growthConfigurationSchema>;
