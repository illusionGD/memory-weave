import { API_CODES } from '@memory-weave/contracts';
import type { DatabaseTransaction } from '../../database/database.service';
import { memoryVersions, messages } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { assertVisible, requireCompanionMember } from '../conversations/conversation-access';
import { memoryRecordEvidence } from './memory-records';

/**
 * 校验记忆批次、实例范围及原文有效性。
 *
 * 读取、派发和提交均核对同一批次及确切原文，防止迟到结果复活删除内容。
 */
export async function requireMemoryBatch(ownerId: string, id: string, tx: DatabaseTransaction) {
  const batch = await tx.memoryBatches.findOne({ where: { id: id } });
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
    const row = await tx.messages.findOne({
      where: {
        conversationId: batch.conversationId,
        id: source.messageId,
        contentVersion: source.contentVersion,
        sequence: source.sequence,
        state: 'published',
        deletedAt: null,
      },
      fields: { id: messages.id },
    });
    if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
  }
  for (const related of batch.input.related) {
    const version = await tx.memoryVersions.findOne({
      where: { memoryId: related.id, id: related.versionId, invalidatedAt: null },
      fields: { id: memoryVersions.id },
    });
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
