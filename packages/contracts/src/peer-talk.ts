import { z } from 'zod';
import {
  idPaginationQueryShape,
  nonnegativeIntegerSchema,
  positiveIntegerSchema,
  utcDateTimeSchema,
  uuidSchema,
} from './common';

const peerPolicy = {
  enabled: z.boolean(),
  publicDescription: z.string().trim().min(1).max(250),
  invitationDecision: z.enum(['accept', 'decline', 'defer']),
  allowExit: z.boolean(),
};
export const configurePeerSchema = z.strictObject({
  ...peerPolicy,
  runtimeEpoch: positiveIntegerSchema,
  expectedVersion: nonnegativeIntegerSchema,
  requestId: uuidSchema,
});
export const peerPolicySchema = z.strictObject({
  ...peerPolicy,
  runtimeEpoch: positiveIntegerSchema,
  version: positiveIntegerSchema,
});
export const peerProfileSchema = z.strictObject({
  companionId: uuidSchema,
  runtimeEpoch: positiveIntegerSchema,
  name: z.string(),
  description: z.string(),
});
export const peerProfilesSchema = z.strictObject({
  items: z.array(peerProfileSchema),
  nextAfterId: uuidSchema.nullable(),
});
export const configurePeerRoomSchema = z.strictObject({
  requestId: uuidSchema,
  expectedVersion: nonnegativeIntegerSchema,
  enabled: z.boolean(),
  allowExit: z.boolean(),
});
export const peerRoomSchema = z.strictObject({
  version: positiveIntegerSchema,
  enabled: z.boolean(),
  allowExit: z.boolean(),
});
export const peerSessionSchema = z.strictObject({
  id: uuidSchema,
  conversationId: uuidSchema,
  triggerMessageId: uuidSchema,
  calls: nonnegativeIntegerSchema,
  maxCalls: positiveIntegerSchema,
  maxOutputTokens: positiveIntegerSchema,
  chargedMicros: nonnegativeIntegerSchema,
  reason: z.string().nullable(),
  createdAt: utcDateTimeSchema,
});
export const peerSessionsSchema = z.strictObject({
  items: z.array(peerSessionSchema),
  nextAfterId: uuidSchema.nullable(),
});
export const peerViewQuerySchema = z.strictObject(idPaginationQueryShape);

export type ConfigurePeer = z.infer<typeof configurePeerSchema>;
export type PeerPolicy = z.infer<typeof peerPolicySchema>;
export type PeerProfile = z.infer<typeof peerProfileSchema>;
export type PeerProfiles = z.infer<typeof peerProfilesSchema>;
export type ConfigurePeerRoom = z.infer<typeof configurePeerRoomSchema>;
export type PeerRoom = z.infer<typeof peerRoomSchema>;
export type PeerSession = z.infer<typeof peerSessionSchema>;
export type PeerSessions = z.infer<typeof peerSessionsSchema>;
