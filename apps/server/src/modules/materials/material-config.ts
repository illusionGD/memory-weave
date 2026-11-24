import { z } from 'zod';

/** 所有材料入口共用的部署预算。 */
export const materialConfigurationSchema = z.strictObject({
  maxStorageBytes: z
    .number()
    .int()
    .min(1)
    .max(2 ** 40)
    .default(1024 ** 3),
  minFreeBytes: z
    .number()
    .int()
    .min(0)
    .max(2 ** 40)
    .default(128 * 1024 ** 2),
  maxAttachments: z.number().int().min(1).max(4).default(4),
  maxFileBytes: z
    .number()
    .int()
    .min(1)
    .max(20 * 1024 * 1024)
    .default(20 * 1024 * 1024),
  maxImagePixels: z.number().int().min(1).max(40_000_000).default(40_000_000),
  maxPdfPages: z.number().int().min(1).max(100).default(100),
  maxTextCharacters: z.number().int().min(1).max(500_000).default(500_000),
  maxWebBytes: z
    .number()
    .int()
    .min(1)
    .max(5 * 1024 * 1024)
    .default(5 * 1024 * 1024),
  parseTimeoutMs: z.number().int().min(1000).max(60_000).default(25_000),
  webTimeoutMs: z.number().int().min(100).max(15_000).default(15_000),
  maxWebImages: z.number().int().min(0).max(6).default(3),
  maxWebImageBytes: z
    .number()
    .int()
    .min(0)
    .max(8 * 1024 * 1024)
    .default(4 * 1024 * 1024),
  maxRedirects: z.number().int().min(0).max(3).default(3),
});

export type MaterialConfiguration = z.infer<typeof materialConfigurationSchema>;
