import { z } from 'zod';
import {
  nonnegativeIntegerSchema,
  positiveIntegerSchema,
  utcDateTimeSchema,
  uuidSchema,
} from './common';

export const newInvitationSchema = z.strictObject({
  requestId: uuidSchema,
  expectedConversationVersion: positiveIntegerSchema,
  companionId: uuidSchema,
  runtimeEpoch: positiveIntegerSchema,
  groupTitle: z.string().trim().min(1).max(80).optional(),
  restoreRemoved: z.boolean().default(false),
});
export const invitationDecisionSchema = z.strictObject({
  requestId: uuidSchema,
  expectedVersion: positiveIntegerSchema,
  decision: z.enum(['accept', 'decline', 'defer', 'cancel']),
});
export const invitationSchema = z.strictObject({
  id: uuidSchema,
  conversationId: uuidSchema,
  companionId: uuidSchema,
  runtimeEpoch: positiveIntegerSchema,
  requestedByMembershipId: uuidSchema.nullable(),
  state: z.enum(['pending', 'deferred', 'accepted', 'declined', 'cancelled', 'expired']),
  version: positiveIntegerSchema,
  acceptedConversationId: uuidSchema.nullable(),
  decidedBy: z.enum(['owner', 'companion']).nullable(),
  createdAt: utcDateTimeSchema,
  expiresAt: utcDateTimeSchema,
});
export const invitationListSchema = z.strictObject({
  items: z.array(invitationSchema),
  nextAfterId: uuidSchema.nullable(),
});

export const memberExitSchema = z.strictObject({
  requestId: uuidSchema,
  expectedConversationVersion: positiveIntegerSchema,
  expectedPermissionVersion: positiveIntegerSchema,
});
export const memberExitResultSchema = z.strictObject({
  membershipId: uuidSchema,
  leftSequence: nonnegativeIntegerSchema,
  permissionVersion: positiveIntegerSchema,
  conversationVersion: positiveIntegerSchema,
  removed: z.boolean(),
});
export const membershipPolicySchema = z.strictObject({
  requestId: uuidSchema,
  expectedConversationVersion: positiveIntegerSchema,
  peerInvitationsEnabled: z.boolean(),
});
export const conversationCloseSchema = z.strictObject({
  requestId: uuidSchema,
  expectedConversationVersion: positiveIntegerSchema,
});

const historyRangeSchema = z
  .strictObject({
    from: positiveIntegerSchema,
    through: positiveIntegerSchema,
  })
  .refine(({ from, through }) => through >= from && through - from < 100);
export const historyRequestSchema = z.strictObject({
  requestId: uuidSchema,
  membershipId: uuidSchema,
  expectedPermissionVersion: positiveIntegerSchema,
  range: historyRangeSchema,
});
export const historyDecisionSchema = z.strictObject({
  requestId: uuidSchema,
  expectedVersion: positiveIntegerSchema,
  decision: z.enum(['approve', 'reject', 'revoke']),
});
export const historyShareSchema = z.strictObject({
  id: uuidSchema,
  conversationId: uuidSchema,
  membershipId: uuidSchema,
  range: historyRangeSchema,
  state: z.enum(['pending', 'approved', 'rejected', 'revoked']),
  version: positiveIntegerSchema,
  permissionVersion: positiveIntegerSchema,
  queuedMessages: nonnegativeIntegerSchema,
  createdAt: utcDateTimeSchema,
});
export const historyShareListSchema = z.strictObject({
  items: z.array(historyShareSchema),
  nextAfterId: uuidSchema.nullable(),
});

export const shareBackgroundSchema = z
  .strictObject({
    requestId: uuidSchema,
    expectedConversationVersion: positiveIntegerSchema,
    sourceConversationId: uuidSchema,
    messageId: uuidSchema,
    contentVersion: positiveIntegerSchema,
    startOffset: nonnegativeIntegerSchema,
    endOffset: positiveIntegerSchema,
  })
  .refine(
    ({ startOffset, endOffset }) => endOffset > startOffset && endOffset - startOffset <= 1200,
  );

export type NewInvitation = z.infer<typeof newInvitationSchema>;
export type InvitationDecision = z.infer<typeof invitationDecisionSchema>;
export type Invitation = z.infer<typeof invitationSchema>;
export type InvitationList = z.infer<typeof invitationListSchema>;
export type MemberExit = z.infer<typeof memberExitSchema>;
export type MemberExitResult = z.infer<typeof memberExitResultSchema>;
export type ConversationClose = z.infer<typeof conversationCloseSchema>;
export type HistoryRequest = z.infer<typeof historyRequestSchema>;
export type HistoryDecision = z.infer<typeof historyDecisionSchema>;
export type HistoryShare = z.infer<typeof historyShareSchema>;
export type HistoryShareList = z.infer<typeof historyShareListSchema>;

export type MembershipPolicy = z.infer<typeof membershipPolicySchema>;

export type ShareBackground = z.infer<typeof shareBackgroundSchema>;
