import { z } from 'zod';

/** 终端在线期限与动作等待期限由部署统一配置。 */
export const terminalConfigurationSchema = z.strictObject({
  heartbeatTimeoutMs: z.number().int().min(200).max(300_000).default(45_000),
  actionTimeoutMs: z.number().int().min(1_000).max(900_000).default(120_000),
});
export type TerminalConfiguration = z.infer<typeof terminalConfigurationSchema>;
