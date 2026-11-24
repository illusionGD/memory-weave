import type { MaterialContext } from '@memory-weave/contracts';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service';
import { materialParts, materialVersions, messageMaterials, messages } from '../../database/schema';

/** 从已经核对成员可见性的原文中选择有界的材料文字。 */
export async function selectMaterialContext(
  ownerId: string,
  rows: (typeof messages.$inferSelect)[],
  firstSequence: number,
  tx: DatabaseTransaction,
): Promise<MaterialContext[]> {
  if (!rows.length) return [];
  const current = rows.filter((row) => row.sequence! >= firstSequence);
  const prompt = current.map((row) => row.text).join('\n');
  const pageNumber = Number(/(?:第\s*)?(\d{1,4})\s*页/u.exec(prompt)?.[1] ?? 0);
  const requestedPage = pageNumber > 0 ? pageNumber : null;
  const candidates = await tx
    .select({
      messageId: messageMaterials.messageId,
      contentVersion: messageMaterials.contentVersion,
      sequence: messages.sequence,
      version: materialVersions,
    })
    .from(messageMaterials)
    .innerJoin(
      messages,
      and(
        eq(messages.ownerId, ownerId),
        eq(messages.id, messageMaterials.messageId),
        eq(messages.contentVersion, messageMaterials.contentVersion),
      ),
    )
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
        inArray(
          messageMaterials.messageId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .orderBy(desc(messages.sequence), asc(messageMaterials.position))
    .limit(4);
  const fresh = candidates.filter((entry) => entry.sequence! >= firstSequence);
  const use = fresh.length
    ? fresh
    : /页|文件|材料|文章|文档|链接|图片|照片|截图|书里/u.test(prompt)
      ? candidates.slice(0, 1)
      : [];
  const out: MaterialContext[] = [];
  let left = 4800;
  for (const entry of use) {
    const version = entry.version;
    const page = version.kind === 'pdf' ? requestedPage : null;
    const where = [
      eq(materialParts.ownerId, ownerId),
      eq(materialParts.materialId, version.id),
      eq(materialParts.status, 'text'),
    ];
    if (page)
      where.push(gte(materialParts.page, Math.max(1, page - 1)), lte(materialParts.page, page + 1));
    const terms = prompt.match(/[\p{Script=Han}]{2,}|[A-Za-z\d]{3,}/gu)?.slice(0, 6) ?? [];
    const rank = page
      ? [sql`ABS(${materialParts.page} - ${page})`]
      : terms.length
        ? [
            desc(
              sql`(${sql.join(
                terms.map((term) => sql`(LOCATE(${term.slice(0, 16)}, ${materialParts.text}) > 0)`),
                sql` + `,
              )})`,
            ),
          ]
        : [];
    const parts =
      left > 0 && ['parsed', 'partial'].includes(version.state)
        ? await tx
            .select()
            .from(materialParts)
            .where(and(...where))
            .orderBy(...rank, asc(materialParts.position))
            .limit(3)
        : [];
    const excerpts: MaterialContext['excerpts'] = [];
    for (const part of parts) {
      if (!part.text || left <= 0) continue;
      const cap = Math.min(left, 1800);
      const text = part.text.slice(0, cap);
      left -= text.length;
      excerpts.push({
        position: part.position,
        page: part.page,
        text,
        truncated: text.length < part.text.length,
      });
    }
    out.push({
      messageId: entry.messageId,
      contentVersion: entry.contentVersion,
      materialId: version.id,
      title: version.title,
      state: version.state,
      reason:
        version.reason ??
        (['jpeg', 'png', 'webp'].includes(version.kind) ? 'image-not-read' : null),
      totalParts: version.partCount,
      requestedPage: page,
      excerpts,
    });
  }
  return out;
}
