import { z } from 'zod';
import {
  idPaginationQueryShape,
  positiveIntegerSchema,
  utcDateTimeSchema,
  uuidSchema,
} from './common';
import { publishedMessageSchema } from './messages';
import { taskSchema } from './tasks';

/** 消息可以由系统选择一位伴侣接话、点名回应或按给定顺序逐人表达。 */
const addressing = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('any') }),
  z.strictObject({ mode: z.literal('mention'), membershipId: uuidSchema }),
  z.strictObject({
    mode: z.literal('each'),
    membershipIds: z
      .array(uuidSchema)
      .min(1)
      .max(20)
      .refine((values) => new Set(values.map((id) => id.toLowerCase())).size === values.length),
  }),
]);
export const groupTurnRequestSchema = z.strictObject({
  requestId: uuidSchema,
  expectedConversationVersion: positiveIntegerSchema,
  text: z.string().trim().min(1).max(4000),
  addressing,
});
export const groupTurnStepSchema = z.strictObject({
  ordinal: positiveIntegerSchema,
  membershipId: uuidSchema,
  companionId: uuidSchema,
  runtimeEpoch: positiveIntegerSchema,
  state: z.enum(['pending', 'spoken', 'silent', 'skipped', 'left']),
  publishedMessageId: uuidSchema.nullable(),
  modelCallId: uuidSchema.nullable(),
  completedAt: utcDateTimeSchema.nullable(),
});
export const groupTurnSchema = z.strictObject({
  id: uuidSchema,
  conversationId: uuidSchema,
  triggerMessageId: uuidSchema,
  triggerSequence: positiveIntegerSchema,
  origin: z.enum(['user', 'autonomous']),
  addressing: z.enum(['any', 'mention', 'each']),
  task: taskSchema,
  steps: z.array(groupTurnStepSchema),
  interruptedAt: utcDateTimeSchema.nullable(),
  createdAt: utcDateTimeSchema,
});
export const createdGroupTurnSchema = z.strictObject({
  message: publishedMessageSchema,
  turn: groupTurnSchema,
});
export const groupTurnListSchema = z.strictObject({
  items: z.array(groupTurnSchema),
  nextAfterId: uuidSchema.nullable(),
});
export const stopGroupTurnSchema = z.strictObject({
  requestId: uuidSchema,
});
export const groupTurnsQuerySchema = z.strictObject(idPaginationQueryShape);

export type GroupTurnRequest = z.infer<typeof groupTurnRequestSchema>;
export type GroupTurnStep = z.infer<typeof groupTurnStepSchema>;
export type GroupTurn = z.infer<typeof groupTurnSchema>;
export type CreatedGroupTurn = z.infer<typeof createdGroupTurnSchema>;
export type GroupTurnList = z.infer<typeof groupTurnListSchema>;
export type StopGroupTurn = z.infer<typeof stopGroupTurnSchema>;
