import { sql } from 'drizzle-orm';
import { fingerprint } from '../shared/http';
import type { MemoryExplorerItem } from '@memory-weave/contracts';
import { memoryEntries, memoryVersions, conversations } from '../../database/schema';
import { toMemoryItem } from '../memories/memory-records';
/** 查询后的权威行，正文的来源校验必须先于映射。 */
export interface ExplorerRecord {
  /** 逻辑记忆及当前头。 */
  entry: typeof memoryEntries.$inferSelect;
  /** 本次展示的版本，可能是历史。 */
  version: typeof memoryVersions.$inferSelect;
  /** 所属会话当前标题。 */
  title: string;
  /** 来源会话的内容变更版本，删除操作开始时即推进。 */
  contentRevision: number;
  /** 该实例成员当前权限版本。 */
  permissionVersion: number;
}
/** 历史状态按当时的版本表达，不用当前分歧覆盖全部旧版本。 */
export function toExplorerItem(row: ExplorerRecord): MemoryExplorerItem {
  return {
    ...toMemoryItem(row.entry, row.version),
    readStamp: explorerReadStamp(row),
    status: row.version.invalidatedAt
      ? 'invalidated'
      : row.entry.currentVersionId === row.version.id
        ? row.entry.status
        : row.version.operation === 'conflict'
          ? 'disputed'
          : 'active',
    conversationId: row.entry.conversationId,
    conversationTitle: row.title,
    isCurrent: row.entry.currentVersionId === row.version.id,
    operation: row.version.operation,
    previousVersionId: row.version.previousVersionId,
    reason: row.version.invalidatedAt ? null : row.version.reason,
  };
}

/** 共用同一查询投影，状态校验不另存正文或证据副本。 */
export const explorerSelection = {
  entry: memoryEntries,
  version: memoryVersions,
  title: conversations.title,
  contentRevision: conversations.contentRevision,
  permissionVersion: sql<number>`(SELECT cm.permission_version FROM conversation_members cm WHERE cm.owner_id = ${memoryEntries.ownerId} AND cm.conversation_id = ${memoryEntries.conversationId} AND cm.companion_id = ${memoryEntries.companionId} AND cm.runtime_epoch = ${memoryEntries.runtimeEpoch} AND cm.kind = 'companion' LIMIT 1)`,
};
/** 指纹只比较可见状态，不能代替每次正文读取时的来源与生命周期校验。 */
export function explorerReadStamp(row: {
  entry: Pick<
    ExplorerRecord['entry'],
    'ownerId' | 'companionId' | 'runtimeEpoch' | 'conversationId' | 'currentVersionId' | 'status'
  >;
  version: Pick<ExplorerRecord['version'], 'id' | 'invalidatedAt'>;
  contentRevision: number;
  permissionVersion: number;
}): string {
  return fingerprint({
    ownerId: row.entry.ownerId,
    companionId: row.entry.companionId,
    runtimeEpoch: row.entry.runtimeEpoch,
    conversationId: row.entry.conversationId,
    versionId: row.version.id,
    head: row.entry.currentVersionId,
    status: row.entry.status,
    invalidatedAt: row.version.invalidatedAt?.toISOString() ?? null,
    contentRevision: row.contentRevision,
    permissionVersion: row.permissionVersion,
  });
}

/** 高频状态核对只取身份和版本字段，不从数据库搬运记忆正文。 */
export const explorerStampSelection = {
  entry: {
    ownerId: memoryEntries.ownerId,
    companionId: memoryEntries.companionId,
    runtimeEpoch: memoryEntries.runtimeEpoch,
    conversationId: memoryEntries.conversationId,
    currentVersionId: memoryEntries.currentVersionId,
    status: memoryEntries.status,
  },
  version: { id: memoryVersions.id, invalidatedAt: memoryVersions.invalidatedAt },
  contentRevision: conversations.contentRevision,
  permissionVersion: explorerSelection.permissionVersion,
};
