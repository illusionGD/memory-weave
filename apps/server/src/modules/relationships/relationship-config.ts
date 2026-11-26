import { z } from 'zod';

/** 短期感受的当前视图有效时间，历史仍按来源保留。 */
export const relationshipConfigurationSchema = z.strictObject({
  selfEmotionTtlMs: z
    .number()
    .int()
    .min(1000)
    .max(7 * 86400000)
    .default(48 * 3600000),
  observedEmotionTtlMs: z
    .number()
    .int()
    .min(1000)
    .max(7 * 86400000)
    .default(6 * 3600000),
});
export type RelationshipConfiguration = z.infer<typeof relationshipConfigurationSchema>;
