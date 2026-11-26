import { z } from 'zod';
import {
  contentVersionQuerySchema,
  idPaginationQueryShape,
  positiveIntegerSchema,
  runtimeEpochQuerySchema,
  utcDateTimeSchema,
  uuidSchema,
} from './common';

/** 状态类型明确区分自身情绪、对方表达、双方各自倾向和约定。 */
export const relationshipKindSchema = z.enum([
  'self_emotion',
  'observed_emotion',
  'other_preference',
  'own_preference',
  'agreement',
  'disagreement',
]);

/** 每项关系状态的证据来自确切消息位置及实际说话者。 */
export const relationshipEvidenceSchema = z.strictObject({
  messageId: uuidSchema,
  contentVersion: positiveIntegerSchema,
  sequence: positiveIntegerSchema,
  startOffset: z.number().int().nonnegative(),
  endOffset: positiveIntegerSchema,
  speakerMembershipId: uuidSchema,
});

export const relationshipDocumentSchema = z.strictObject({
  description: z.string().trim().min(1).max(400),
  reason: z.string().trim().min(1).max(400),
  provenance: z.enum(['expression', 'inference', 'mutual']),
});

/** 关系视角属于一个实例代次，对方保持公开的成员身份。 */
export const relationshipStateSchema = z.strictObject({
  id: uuidSchema,
  companionId: uuidSchema,
  conversationId: uuidSchema,
  runtimeEpoch: positiveIntegerSchema,
  counterpartMembershipId: uuidSchema,
  kind: relationshipKindSchema,
  topic: z.string(),
  version: positiveIntegerSchema,
  currentVersion: positiveIntegerSchema,
  status: z.enum(['current', 'historical', 'expired', 'invalidated']),
  document: relationshipDocumentSchema.nullable(),
  evidence: z.array(relationshipEvidenceSchema),
  mode: z.enum(['test', 'model']),
  observedAt: utcDateTimeSchema,
  expiresAt: utcDateTimeSchema.nullable(),
  createdAt: utcDateTimeSchema,
});

/** 当前状态按确切会话及代次分页。 */
export const relationshipQuerySchema = z.strictObject({
  ...idPaginationQueryShape,
  runtimeEpoch: runtimeEpochQuerySchema,
  conversationId: uuidSchema,
  counterpartMembershipId: uuidSchema.optional(),
});
export const relationshipHistoryQuerySchema = z.strictObject({
  limit: idPaginationQueryShape.limit,
  beforeVersion: contentVersionQuerySchema.optional(),
});
export const relationshipListSchema = z.strictObject({
  items: z.array(relationshipStateSchema),
  nextAfterId: uuidSchema.nullable(),
});
export const relationshipHistorySchema = z.strictObject({
  items: z.array(relationshipStateSchema),
  nextBeforeVersion: positiveIntegerSchema.nullable(),
});

export type RelationshipKind = z.infer<typeof relationshipKindSchema>;
export type RelationshipEvidence = z.infer<typeof relationshipEvidenceSchema>;
export type RelationshipDocument = z.infer<typeof relationshipDocumentSchema>;
export type RelationshipState = z.infer<typeof relationshipStateSchema>;
export type RelationshipQuery = z.infer<typeof relationshipQuerySchema>;
export type RelationshipHistoryQuery = z.infer<typeof relationshipHistoryQuerySchema>;
export type RelationshipList = z.infer<typeof relationshipListSchema>;
export type RelationshipHistory = z.infer<typeof relationshipHistorySchema>;

/** 实际传给聊天模型的定向状态与有效原文身份。 */
export const relationshipContextSchema = z.strictObject({
  stateId: uuidSchema,
  version: positiveIntegerSchema,
  kind: relationshipKindSchema,
  topic: z.string(),
  document: relationshipDocumentSchema,
  observedAt: utcDateTimeSchema,
  sources: z.array(
    z.strictObject({ messageId: uuidSchema, contentVersion: positiveIntegerSchema }),
  ),
});
export type RelationshipContext = z.infer<typeof relationshipContextSchema>;
