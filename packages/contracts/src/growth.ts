import { z } from 'zod';
import {
  contentVersionQuerySchema,
  idPaginationQueryShape,
  nonnegativeIntegerSchema,
  positiveIntegerSchema,
  runtimeEpochQuerySchema,
  utcDateTimeSchema,
  uuidSchema,
} from './common';

export const growthDimensionSchema = z.enum([
  'interest',
  'aesthetic',
  'expression',
  'thought',
  'viewpoint',
]);
export const growthTopicSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/u);
export const growthTraitSchema = z.strictObject({
  growthId: uuidSchema,
  topic: growthTopicSchema,
  dimension: growthDimensionSchema,
  text: z.string().trim().min(1).max(400),
  applicability: z.string().trim().min(1).max(300),
});

export const growthProposalSchema = growthTraitSchema.omit({ growthId: true }).extend({
  reason: z.string().trim().min(1).max(600),
  supportEventIds: z.array(uuidSchema).min(2).max(8),
  counterexampleEventIds: z.array(uuidSchema).max(8),
});
export const growthValidationResultSchema = z.strictObject({
  accept: z.boolean(),
  evidenceSufficient: z.boolean(),
  preservesLocks: z.boolean(),
  localChange: z.boolean(),
  reason: z.string().trim().min(1).max(600),
});
export const growthStatusSchema = z.enum([
  'queued',
  'no_change',
  'observing',
  'rejected',
  'adopted',
  'invalidated',
]);
export const growthCandidateSchema = z.strictObject({
  id: uuidSchema,
  taskId: uuidSchema,
  mode: z.enum(['test', 'model']),
  status: growthStatusSchema,
  sourceRunId: uuidSchema,
  expectedPersonaVersionId: uuidSchema,
  adoptedPersonaVersionId: uuidSchema.nullable(),
  proposal: growthProposalSchema.nullable(),
  validation: growthValidationResultSchema.nullable(),
  reason: z.string().nullable(),
  createdAt: utcDateTimeSchema,
});
export const growthCandidatesSchema = z.strictObject({
  items: z.array(growthCandidateSchema),
  nextAfterId: uuidSchema.nullable(),
});
export const growthControlSchema = z.strictObject({
  runtimeEpoch: positiveIntegerSchema,
  version: nonnegativeIntegerSchema,
  frozen: z.boolean(),
});
export const growthFreezeSchema = z.strictObject({
  runtimeEpoch: positiveIntegerSchema,
  expectedVersion: nonnegativeIntegerSchema,
  requestId: uuidSchema,
  frozen: z.boolean(),
});
export const growthRollbackSchema = z.strictObject({
  runtimeEpoch: positiveIntegerSchema,
  expectedPersonaVersionId: uuidSchema,
  targetPersonaVersionId: uuidSchema,
  requestId: uuidSchema,
});
export const growthQuerySchema = z.strictObject({
  ...idPaginationQueryShape,
  runtimeEpoch: runtimeEpochQuerySchema,
});
export const growthControlQuerySchema = z.strictObject({ runtimeEpoch: runtimeEpochQuerySchema });
export const growthVersionQuerySchema = z.strictObject({
  limit: idPaginationQueryShape.limit,
  runtimeEpoch: runtimeEpochQuerySchema,
  beforeVersion: contentVersionQuerySchema.optional(),
});

export type GrowthTrait = z.infer<typeof growthTraitSchema>;
export type GrowthProposal = z.infer<typeof growthProposalSchema>;
export type GrowthValidationResult = z.infer<typeof growthValidationResultSchema>;
export type GrowthCandidate = z.infer<typeof growthCandidateSchema>;
export type GrowthCandidates = z.infer<typeof growthCandidatesSchema>;
export type GrowthControl = z.infer<typeof growthControlSchema>;
export type GrowthFreeze = z.infer<typeof growthFreezeSchema>;
export type GrowthRollback = z.infer<typeof growthRollbackSchema>;
export type GrowthQuery = z.infer<typeof growthQuerySchema>;
export type GrowthVersionQuery = z.infer<typeof growthVersionQuerySchema>;
