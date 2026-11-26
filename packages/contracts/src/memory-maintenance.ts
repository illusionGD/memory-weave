import { z } from 'zod';
import {
  nonnegativeIntegerSchema,
  positiveIntegerSchema,
  utcDateTimeSchema,
  uuidSchema,
} from './common';

export const embeddingSpaceIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const embeddingSpaceStatusSchema = z.strictObject({
  space: embeddingSpaceIdSchema,
  configVersion: positiveIntegerSchema,
  providerId: z.string(),
  model: z.string(),
  dimensions: positiveIntegerSchema,
  collection: z.string(),
  eligibleVersions: nonnegativeIntegerSchema,
  indexedVersions: nonnegativeIntegerSchema,
  staleVersions: nonnegativeIntegerSchema,
  compatible: z.boolean(),
  syncing: z.boolean(),
});
export const embeddingSelectionSchema = z.strictObject({
  version: nonnegativeIntegerSchema,
  active: embeddingSpaceIdSchema.nullable(),
  previous: embeddingSpaceIdSchema.nullable(),
  configured: embeddingSpaceIdSchema.nullable(),
  spaces: z.array(embeddingSpaceStatusSchema),
});
export const switchEmbeddingSchema = z.strictObject({
  requestId: uuidSchema,
  expectedVersion: positiveIntegerSchema,
  targetSpace: embeddingSpaceIdSchema,
  evaluationNote: z.string().trim().min(1).max(500),
});
export const switchedEmbeddingSchema = z.strictObject({
  version: positiveIntegerSchema,
  space: embeddingSpaceIdSchema,
  previous: embeddingSpaceIdSchema.nullable(),
  evaluationNote: z.string(),
  switchedAt: utcDateTimeSchema,
});
export type EmbeddingSelection = z.infer<typeof embeddingSelectionSchema>;
export type SwitchEmbedding = z.infer<typeof switchEmbeddingSchema>;
export type SwitchedEmbedding = z.infer<typeof switchedEmbeddingSchema>;

export const memoryMaintenanceConfigurationSchema = z
  .strictObject({
    enabled: z.boolean().default(true),
    intervalMs: z
      .number()
      .int()
      .min(1000)
      .max(7 * 86400000)
      .default(86400000),
    ageHalfLifeDays: z.number().min(1).max(365).default(30),
    compressAfterDays: z.number().min(0.00001).max(3650).default(30),
    archiveAfterDays: z.number().min(0.00001).max(3650).default(90),
    batchSize: z.number().int().min(1).max(100).default(12),
  })
  .refine((c) => c.archiveAfterDays >= c.compressAfterDays);
export type MemoryMaintenanceConfiguration = z.infer<typeof memoryMaintenanceConfigurationSchema>;

export const memoryMaintenanceSchema = z.strictObject({
  versionId: uuidSchema,
  tier: z.enum(['compressed', 'archived']),
  /** 摘录保持原义和定位；无法可靠缩短时继续保留明细。 */
  summary: z.string().nullable(),
  lastEvidenceAt: utcDateTimeSchema,
  evaluatedAt: utcDateTimeSchema,
  policy: memoryMaintenanceConfigurationSchema,
  evidence: z.array(
    z.strictObject({ messageId: uuidSchema, contentVersion: positiveIntegerSchema }),
  ),
});
export type MemoryMaintenance = z.infer<typeof memoryMaintenanceSchema>;
