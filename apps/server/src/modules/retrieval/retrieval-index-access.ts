import { and, eq, isNull } from 'drizzle-orm';
import { API_CODES } from '@memory-weave/contracts';
import type { DatabaseTransaction } from '../../database/database.service';
import { memoryEntries, memoryVersions, memoryVectorIndexes } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { assertVersionSources } from '../memories/memory-records';

/** 模型派发、向量写入及进度提交前核对权威版本和来源。 */
export async function requireIndexSource(ownerId: string, id: string, tx: DatabaseTransaction) {
  const [row] = await tx
    .select({ index: memoryVectorIndexes, entry: memoryEntries, version: memoryVersions })
    .from(memoryVectorIndexes)
    .innerJoin(memoryEntries, eq(memoryEntries.id, memoryVectorIndexes.memoryId))
    .innerJoin(memoryVersions, eq(memoryVersions.id, memoryVectorIndexes.versionId))
    .where(
      and(
        eq(memoryVectorIndexes.ownerId, ownerId),
        eq(memoryVectorIndexes.id, id),
        isNull(memoryVersions.invalidatedAt),
      ),
    );
  if (
    !row?.version.document ||
    row.index.status === 'deleted' ||
    row.entry.status === 'invalidated' ||
    row.entry.currentVersionId !== row.version.id
  )
    throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
  await assertVersionSources(ownerId, row.entry, row.version, tx);
  return row;
}
