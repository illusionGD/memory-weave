import { z } from 'zod';
import {
  idPaginationQueryShape,
  nonnegativeIntegerSchema,
  positiveIntegerSchema,
  runtimeEpochQuerySchema,
  utcDateTimeSchema,
  uuidSchema,
} from './common';

const policyFields = {
  conversationId: uuidSchema,
  enabled: z.boolean(),
  contactsEnabled: z.boolean(),
};
export const configureAutonomySchema = z
  .strictObject({
    ...policyFields,
    runtimeEpoch: positiveIntegerSchema,
    expectedVersion: nonnegativeIntegerSchema,
    requestId: uuidSchema,
  })
  .refine(({ enabled, contactsEnabled }) => enabled || !contactsEnabled);
export const autonomyPolicySchema = z.strictObject({
  ...policyFields,
  runtimeEpoch: positiveIntegerSchema,
  version: positiveIntegerSchema,
});
export const autonomyQuerySchema = z.strictObject({
  ...idPaginationQueryShape,
  runtimeEpoch: runtimeEpochQuerySchema,
});
export const autonomyOutcomeSchema = z.enum([
  'pending',
  'quiet',
  'activity',
  'contact',
  'invitation',
  'invalidated',
]);
export const autonomyOpportunitySchema = z.strictObject({
  id: uuidSchema,
  conversationId: uuidSchema,
  runtimeEpoch: positiveIntegerSchema,
  outcome: autonomyOutcomeSchema,
  mode: z.enum(['test', 'model']),
  reason: z.string().nullable(),
  explanation: z.string().nullable(),
  activityId: uuidSchema.nullable(),
  contactId: uuidSchema.nullable(),
  invitationId: uuidSchema.nullable().default(null),
  createdAt: utcDateTimeSchema,
});
export const autonomyOpportunitiesSchema = z.strictObject({
  items: z.array(autonomyOpportunitySchema),
  nextAfterId: uuidSchema.nullable(),
});
export const contactStateSchema = z.enum([
  'pending',
  'published',
  'acknowledged',
  'expired',
  'cancelled',
]);
export const contactIntentSchema = z.strictObject({
  id: uuidSchema,
  companionId: uuidSchema,
  conversationId: uuidSchema,
  state: contactStateSchema,
  reason: z.string().nullable(),
  explanation: z.string().nullable(),
  messageId: uuidSchema.nullable(),
  createdAt: utcDateTimeSchema,
  expiresAt: utcDateTimeSchema,
  publishedAt: utcDateTimeSchema.nullable(),
  acknowledgedAt: utcDateTimeSchema.nullable(),
});
export const contactIntentsSchema = z.strictObject({
  items: z.array(contactIntentSchema),
  nextAfterId: uuidSchema.nullable(),
});
export type ConfigureAutonomy = z.infer<typeof configureAutonomySchema>;
export type AutonomyPolicy = z.infer<typeof autonomyPolicySchema>;
export type AutonomyQuery = z.infer<typeof autonomyQuerySchema>;
export type AutonomyOpportunity = z.infer<typeof autonomyOpportunitySchema>;
export type AutonomyOpportunities = z.infer<typeof autonomyOpportunitiesSchema>;
export type ContactIntent = z.infer<typeof contactIntentSchema>;
export type ContactIntents = z.infer<typeof contactIntentsSchema>;
