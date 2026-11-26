import { z } from 'zod';

/** 验证实际可用的 IANA 时区。 */
function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** 探索和主动联系的部署参数，权限仍由账号逐实例开启。 */
export const autonomyConfigurationSchema = z.strictObject({
  enabled: z.boolean().default(true),
  timeZone: z.string().max(80).refine(knownZone).default('UTC'),
  explorationIntervalMs: z
    .number()
    .int()
    .min(1000)
    .max(7 * 86400000)
    .default(6 * 3600000),
  explorationsPerDay: z.number().int().min(1).max(24).default(4),
  modelCallsPerDay: z.number().int().min(1).max(100).default(12),
  contactsPerDay: z.number().int().min(1).max(10).default(2),
  contactIntervalMs: z
    .number()
    .int()
    .min(1000)
    .max(7 * 86400000)
    .default(4 * 3600000),
  unansweredIntervalMs: z
    .number()
    .int()
    .min(1000)
    .max(7 * 86400000)
    .default(86400000),
  contactExpiryMs: z
    .number()
    .int()
    .min(1000)
    .max(7 * 86400000)
    .default(86400000),
  quietStartHour: z.number().int().min(0).max(23).default(23),
  quietEndHour: z.number().int().min(0).max(23).default(9),
});
export type AutonomyConfiguration = z.infer<typeof autonomyConfigurationSchema>;
