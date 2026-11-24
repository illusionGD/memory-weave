import type { MaterialSummary } from '@memory-weave/contracts';
import { and, asc, eq } from 'drizzle-orm';
import type { QueryDatabase } from '../../database/database.service';
import { materialVersions, messageMaterials } from '../../database/schema';

/** 转换材料版本状态，仅输出可公开显示的字段。 */
export function materialSummary(
  row: Pick<
    typeof materialVersions.$inferSelect,
    | 'id'
    | 'kind'
    | 'title'
    | 'state'
    | 'reason'
    | 'sourceUrl'
    | 'acquiredAt'
    | 'byteLength'
    | 'partCount'
  >,
): MaterialSummary {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    state: row.state,
    reason: row.reason,
    sourceUrl: row.sourceUrl,
    acquiredAt: row.acquiredAt?.toISOString() ?? null,
    byteLength: row.byteLength,
    partCount: row.partCount,
  };
}

/** 读取消息确切内容版本上的有序材料引用。 */
export async function materialsForMessage(
  ownerId: string,
  messageId: string,
  contentVersion: number,
  db: QueryDatabase,
): Promise<MaterialSummary[]> {
  const rows = await db
    .select({ version: materialVersions })
    .from(messageMaterials)
    .innerJoin(
      materialVersions,
      and(
        eq(materialVersions.ownerId, ownerId),
        eq(materialVersions.id, messageMaterials.materialId),
      ),
    )
    .where(
      and(
        eq(messageMaterials.ownerId, ownerId),
        eq(messageMaterials.messageId, messageId),
        eq(messageMaterials.contentVersion, contentVersion),
      ),
    )
    .orderBy(asc(messageMaterials.position));
  return rows.map(({ version }) => materialSummary(version));
}
