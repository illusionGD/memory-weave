import { z } from 'zod';
import {
  contentVersionQuerySchema,
  idPaginationQueryShape,
  positiveIntegerSchema,
  runtimeEpochQuerySchema,
  utcDateTimeSchema,
  uuidSchema,
} from './common';
import { taskStatusSchema } from './tasks';

export const reflectionScopeSchema = z.strictObject({
  conversationId: uuidSchema,
  runtimeEpoch: positiveIntegerSchema,
});
export const reflectionQuerySchema = z.strictObject({
  ...idPaginationQueryShape,
  conversationId: uuidSchema,
  runtimeEpoch: runtimeEpochQuerySchema,
});

export const reflectionKindSchema = z.enum(['belief', 'autobiography']);
export const reflectionSourceSchema = z.strictObject({
  eventId: uuidSchema,
  kind: z.enum(['memory', 'activity', 'relationship']),
  sourceId: uuidSchema,
  sourceVersion: positiveIntegerSchema,
});
export const reflectionEvidenceSchema = reflectionSourceSchema.extend({
  role: z.enum(['support', 'counterexample']),
  excerpt: z.string().min(1).max(600),
});

export const reflectionDocumentSchema = z.strictObject({
  account: z.string().trim().min(1).max(900),
  interpretation: z.string().trim().min(1).max(900),
  applicability: z.string().trim().min(1).max(400),
  uncertainty: z.string().trim().min(1).max(400).nullable(),
});

export const reflectionFindingSchema = z.strictObject({
  id: uuidSchema,
  versionId: uuidSchema,
  topic: z.string(),
  kind: reflectionKindSchema,
  version: positiveIntegerSchema,
  status: z.enum(['current', 'historical', 'observing', 'invalidated']),
  mode: z.enum(['test', 'model']),
  document: reflectionDocumentSchema.nullable(),
  evidence: z.array(reflectionEvidenceSchema),
  createdAt: utcDateTimeSchema,
});

export const reflectionRunSchema = z.strictObject({
  id: uuidSchema,
  companionId: uuidSchema,
  scope: reflectionScopeSchema,
  status: taskStatusSchema,
  reason: z.string().nullable(),
  eventCount: z.number().int().nonnegative(),
  mode: z.enum(['test', 'model']),
  conclusion: z.string().nullable(),
  adopted: z.number().int().nonnegative(),
  observing: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  createdAt: utcDateTimeSchema,
  completedAt: utcDateTimeSchema.nullable(),
});
export const reflectionStartSchema = z.strictObject({
  state: z.enum([
    'queued',
    'already_queued',
    'no_meaningful_changes',
    'rate_limited',
    'input_budget',
    'disabled',
  ]),
  runId: uuidSchema.nullable(),
});
export const reflectionRunListSchema = z.strictObject({
  items: z.array(reflectionRunSchema),
  nextAfterId: uuidSchema.nullable(),
});
export const reflectionFindingListSchema = z.strictObject({
  items: z.array(reflectionFindingSchema),
  nextAfterId: uuidSchema.nullable(),
});
export const reflectionHistoryQuerySchema = z.strictObject({
  limit: idPaginationQueryShape.limit,
  beforeVersion: contentVersionQuerySchema.optional(),
});

export type ReflectionKind = z.infer<typeof reflectionKindSchema>;
export type ReflectionSource = z.infer<typeof reflectionSourceSchema>;
export type ReflectionEvidence = z.infer<typeof reflectionEvidenceSchema>;
export type ReflectionDocument = z.infer<typeof reflectionDocumentSchema>;
export type ReflectionScope = z.infer<typeof reflectionScopeSchema>;
export type ReflectionQuery = z.infer<typeof reflectionQuerySchema>;
export type ReflectionRun = z.infer<typeof reflectionRunSchema>;
export type ReflectionFinding = z.infer<typeof reflectionFindingSchema>;
export type ReflectionStart = z.infer<typeof reflectionStartSchema>;
export type ReflectionRunList = z.infer<typeof reflectionRunListSchema>;
export type ReflectionFindingList = z.infer<typeof reflectionFindingListSchema>;
export type ReflectionHistoryQuery = z.infer<typeof reflectionHistoryQuerySchema>;

/** 模型本轮实际读取的有限认识及其可撤回来源。 */
export const reflectionContextSchema = z.strictObject({
  versionId: uuidSchema,
  kind: reflectionKindSchema,
  interpretation: reflectionDocumentSchema.shape.interpretation,
  applicability: reflectionDocumentSchema.shape.applicability,
  uncertainty: reflectionDocumentSchema.shape.uncertainty,
  sources: z.array(
    z.strictObject({ messageId: uuidSchema, contentVersion: positiveIntegerSchema }),
  ),
});
export type ReflectionContext = z.infer<typeof reflectionContextSchema>;
