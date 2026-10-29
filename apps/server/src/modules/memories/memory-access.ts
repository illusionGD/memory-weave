import { memoryRecordEvidence } from './memory-records';
import { API_CODES } from '@memory-weave/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service';
import { memoryBatches, messages, memoryVersions } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { assertVisible, requireCompanionMember } from '../conversations/conversation-access';

/** 读取、派发和提交均核对同一批次及确切原文，防止迟到结果复活删除内容。 */
export async function requireMemoryBatch(ownerId: string, id: string, tx: DatabaseTransaction) {
  const [batch] = await tx
    .select()
    .from(memoryBatches)
    .where(and(eq(memoryBatches.ownerId, ownerId), eq(memoryBatches.id, id)));
  if (!batch?.input) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
  const member = await requireCompanionMember(
    ownerId,
    batch.companionId,
    batch.runtimeEpoch,
    batch.conversationId,
    tx,
  );
  if (member.permissionVersion !== batch.input.permissionVersion)
    throw new ApiException(API_CODES.PERMISSION_VERSION_CONFLICT);
  for (const source of batch.input.messages) {
    await assertVisible(member, source.sequence, tx);
    const [row] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.ownerId, ownerId),
          eq(messages.conversationId, batch.conversationId),
          eq(messages.id, source.messageId),
          eq(messages.contentVersion, source.contentVersion),
          eq(messages.sequence, source.sequence),
          eq(messages.state, 'published'),
          isNull(messages.deletedAt),
        ),
      );
    if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
  }
  for (const related of batch.input.related) {
    const [version] = await tx
      .select({ id: memoryVersions.id })
      .from(memoryVersions)
      .where(
        and(
          eq(memoryVersions.ownerId, ownerId),
          eq(memoryVersions.memoryId, related.id),
          eq(memoryVersions.id, related.versionId),
          isNull(memoryVersions.invalidatedAt),
        ),
      );
    if (!version) throw new ApiException(API_CODES.VERSION_CONFLICT);
    await memoryRecordEvidence(
      ownerId,
      batch.companionId,
      related.id,
      related.versionId,
      { runtimeEpoch: batch.runtimeEpoch, conversationId: batch.conversationId, limit: 1 },
      tx,
    );
  }
  return batch;
}
