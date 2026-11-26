import { z } from 'zod';
import {
  idPaginationQueryShape,
  nonnegativeIntegerSchema,
  positiveIntegerSchema,
  runtimeEpochQuerySchema,
  utcDateTimeSchema,
  uuidSchema,
} from './common';
import { modelCallStatusSchema, modelTaskRoleSchema } from './models';
import { lifecycleOperationSchema } from './lifecycle';

export const administrationConfigurationSchema = z.strictObject({
  groups: z.array(
    z.strictObject({
      name: z.string(),
      source: z.enum(['default', 'deployment']),
      version: z.union([positiveIntegerSchema, z.string()]),
      values: z.record(z.string(), z.json()),
      defaults: z.record(z.string(), z.json()).nullable(),
      scope: z.literal('deployment'),
      update: z.enum(['environment', 'api', 'file']),
      endpoint: z.string().nullable(),
    }),
  ),
  instanceOverrides: z.array(z.strictObject({ name: z.string(), endpoint: z.string() })),
});
export type AdministrationConfiguration = z.infer<typeof administrationConfigurationSchema>;

export const administrationCallsQuerySchema = z
  .strictObject({
    ...idPaginationQueryShape,
    role: modelTaskRoleSchema.optional(),
    status: modelCallStatusSchema.optional(),
    companionId: uuidSchema.optional(),
    runtimeEpoch: runtimeEpochQuerySchema.optional(),
    conversationId: uuidSchema.optional(),
  })
  .refine((query) => (query.companionId === undefined) === (query.runtimeEpoch === undefined));
export type AdministrationCallsQuery = z.infer<typeof administrationCallsQuerySchema>;

export const administrationCallsSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      id: uuidSchema,
      role: modelTaskRoleSchema,
      status: modelCallStatusSchema,
      lane: z.enum(['interactive', 'background']),
      configVersion: positiveIntegerSchema,
      providerId: z.string(),
      model: z.string(),
      companionId: uuidSchema.nullable(),
      conversationId: uuidSchema.nullable(),
      runtimeEpoch: positiveIntegerSchema.nullable(),
      invalidated: z.boolean(),
      attempts: nonnegativeIntegerSchema,
      tokens: nonnegativeIntegerSchema,
      chargedCostMicros: nonnegativeIntegerSchema,
      elapsedMs: nonnegativeIntegerSchema.nullable(),
      errorCode: z.number().int().nullable(),
      createdAt: utcDateTimeSchema,
    }),
  ),
  nextAfterId: uuidSchema.nullable(),
});
export type AdministrationCalls = z.infer<typeof administrationCallsSchema>;

export const administrationMessageSchema = z.strictObject({
  messageId: uuidSchema,
  conversationId: uuidSchema,
  contentVersion: positiveIntegerSchema,
  sourceKind: z.string(),
  sequence: positiveIntegerSchema.nullable(),
  published: z.boolean(),
  deleted: z.boolean(),
  participants: z.array(
    z.strictObject({
      companionId: uuidSchema,
      runtimeEpoch: positiveIntegerSchema,
      permissionVersion: positiveIntegerSchema,
      visible: z.boolean(),
      read: z
        .strictObject({
          at: utcDateTimeSchema,
          startOffset: nonnegativeIntegerSchema,
          endOffset: nonnegativeIntegerSchema,
        })
        .nullable(),
      processing: z.enum(['pending', 'processing', 'processed']).nullable(),
    }),
  ),
  deliveries: z.array(z.strictObject({ terminalId: uuidSchema, at: utcDateTimeSchema })),
  deliveriesNextAfterId: uuidSchema.nullable(),
});
export type AdministrationMessage = z.infer<typeof administrationMessageSchema>;

export const administrationLifecycleSchema = z.strictObject({
  operation: lifecycleOperationSchema,
  selected: nonnegativeIntegerSchema,
  derived: nonnegativeIntegerSchema,
  targets: z.array(
    z.strictObject({
      id: uuidSchema,
      messageId: uuidSchema,
      contentVersion: positiveIntegerSchema,
      kind: z.enum(['selected', 'derived']),
    }),
  ),
  nextAfterId: uuidSchema.nullable(),
});
export type AdministrationLifecycle = z.infer<typeof administrationLifecycleSchema>;

export const changeMemoryPinSchema = z.strictObject({
  runtimeEpoch: positiveIntegerSchema,
  requestId: uuidSchema,
  expectedMemoryVersion: positiveIntegerSchema,
  expectedPinVersion: nonnegativeIntegerSchema,
  pinned: z.boolean(),
});
export const memoryPinSchema = z.strictObject({
  memoryId: uuidSchema,
  version: nonnegativeIntegerSchema,
  pinned: z.boolean(),
});
export type ChangeMemoryPin = z.infer<typeof changeMemoryPinSchema>;
export type MemoryPin = z.infer<typeof memoryPinSchema>;
