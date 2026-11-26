import { z } from 'zod';

/** 会话生成与费用限制，各参与者仍受自主额度约束。 */
export const peerConfigurationSchema = z.strictObject({
  enabled: z.boolean().default(true),
  sessionCalls: z.number().int().min(1).max(20).default(6),
  outputTokens: z.number().int().min(64).max(4000).default(500),
  sessionCostMicros: z.number().int().min(0).max(10_000_000).default(50_000),
  topicCooldownMs: z
    .number()
    .int()
    .min(1000)
    .max(7 * 86400000)
    .default(3600000),
});
export type PeerConfiguration = z.infer<typeof peerConfigurationSchema>;
