import { z } from 'zod';
import {
  contentVersionQuerySchema,
  idPaginationQueryShape,
  positiveIntegerSchema,
  runtimeEpochQuerySchema,
  utcDateTimeSchema,
  uuidSchema,
} from './common';
import { taskSchema } from './tasks';

/** 只识别同一会话中可访问的确切原文版本。 */
const sourceSchema = z.strictObject({
  messageId: uuidSchema,
  contentVersion: positiveIntegerSchema,
});

/** 活动与当前实例代次及会话绑定。 */
export const activityScopeSchema = z.strictObject({
  companionId: uuidSchema,
  runtimeEpoch: positiveIntegerSchema,
  conversationId: uuidSchema,
});

const goal = { goal: z.string().trim().min(1).max(1200), dependsOnActionId: uuidSchema.optional() };
export const activityGoalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...goal, kind: z.literal('write'), source: sourceSchema.optional() }),
  z.strictObject({
    ...goal,
    kind: z.literal('read'),
    source: sourceSchema.extend({ materialId: uuidSchema }),
    range: z
      .strictObject({
        from: positiveIntegerSchema,
        through: positiveIntegerSchema,
      })
      .refine(({ from, through }) => through >= from && through - from < 8),
  }),
]);

export const createActivitySchema = activityScopeSchema.extend({
  requestId: uuidSchema,
  specification: activityGoalSchema,
});
export const reviseActivitySchema = z.strictObject({
  requestId: uuidSchema,
  expectedVersion: positiveIntegerSchema,
  specification: activityGoalSchema,
});
export const activityListQuerySchema = activityScopeSchema.extend({
  ...idPaginationQueryShape,
  runtimeEpoch: runtimeEpochQuerySchema,
});
export const activityVersionQuerySchema = z.strictObject({
  beforeVersion: contentVersionQuerySchema.optional(),
  limit: idPaginationQueryShape.limit,
});
export const activityVersionParamSchema = contentVersionQuerySchema;

export const activityCoverageSchema = z.strictObject({
  position: positiveIntegerSchema,
  page: positiveIntegerSchema.nullable(),
  status: z.enum(['included', 'truncated', 'no-text-layer', 'image']),
});

/** 成果及使用的实际文字区间。 */
export const activityArtifactSchema = z.strictObject({
  text: z.string().min(1),
  kind: z.enum(['write', 'read']),
  mode: z.enum(['test', 'model']),
  coverage: z.array(activityCoverageSchema),
  createdAt: utcDateTimeSchema,
});

export const activitySchema = z.strictObject({
  id: uuidSchema,
  scope: activityScopeSchema,
  version: positiveIntegerSchema,
  currentVersion: positiveIntegerSchema,
  specification: activityGoalSchema,
  task: taskSchema,
  coverage: z.array(activityCoverageSchema),
  artifact: activityArtifactSchema.nullable(),
  delivery: z.enum(['unavailable', 'available', 'acknowledged']),
  acknowledgedAt: utcDateTimeSchema.nullable(),
  createdAt: utcDateTimeSchema,
});
export const activityListSchema = z.strictObject({
  items: z.array(activitySchema),
  nextAfterId: uuidSchema.nullable(),
});
export const activityVersionListSchema = z.strictObject({
  items: z.array(activitySchema),
  nextBeforeVersion: positiveIntegerSchema.nullable(),
});

export type Activity = z.infer<typeof activitySchema>;
export type ActivityScope = z.infer<typeof activityScopeSchema>;
export type ActivityGoal = z.infer<typeof activityGoalSchema>;
export type CreateActivity = z.infer<typeof createActivitySchema>;
export type ReviseActivity = z.infer<typeof reviseActivitySchema>;
export type ActivityListQuery = z.infer<typeof activityListQuerySchema>;
export type ActivityVersionQuery = z.infer<typeof activityVersionQuerySchema>;
export type ActivityCoverage = z.infer<typeof activityCoverageSchema>;
export type ActivityArtifact = z.infer<typeof activityArtifactSchema>;
export type ActivityList = z.infer<typeof activityListSchema>;
export type ActivityVersionList = z.infer<typeof activityVersionListSchema>;
