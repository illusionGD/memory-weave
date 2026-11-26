import { API_CODES } from '@memory-weave/contracts';
import type { ActivityCoverage, ActivityGoal } from '@memory-weave/contracts';
import { and, asc, between, eq, isNull } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service';
import { materialParts, materialVersions, messageMaterials, messages } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { assertVisible } from '../conversations/conversation-access';
import type { requireCompanionMember } from '../conversations/conversation-access';

type Member = Awaited<ReturnType<typeof requireCompanionMember>>;

/** 收集活动真实输入后保存，恢复时使用同一份有界内容与片段覆盖记录。 */
export interface ActivityPreparation {
  context?: string;
  contextTruncated?: boolean;
  excerpts?: { position: number; text: string }[];
  coverage: ActivityCoverage[];
  outline?: string;
}

/** 已有依据才推进，未完成的解析可等待，缺失的文字不能冒充已读。 */
export type ActivityInput =
  | { state: 'ready'; preparation: ActivityPreparation }
  | { state: 'waiting'; reason: string }
  | { state: 'blocked'; reason: string };

/** 核对原文版本和可见性，读取实际可用的文字。 */
export async function resolveActivityInput(
  ownerId: string,
  specification: ActivityGoal,
  member: Member,
  tx: DatabaseTransaction,
): Promise<ActivityInput> {
  const source = specification.source;
  if (!source) return { state: 'ready', preparation: { coverage: [] } };
  const [message] = await tx
    .select({ sequence: messages.sequence, text: messages.text })
    .from(messages)
    .where(
      and(
        eq(messages.ownerId, ownerId),
        eq(messages.conversationId, member.conversationId),
        eq(messages.id, source.messageId),
        eq(messages.contentVersion, source.contentVersion),
        eq(messages.state, 'published'),
        isNull(messages.deletedAt),
      ),
    )
    .limit(1);
  if (message?.sequence == null) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
  await assertVisible(member, message.sequence, tx);
  if (specification.kind === 'write') {
    return {
      state: 'ready',
      preparation: {
        context: message.text.slice(0, 800).replace(/[\uD800-\uDBFF]$/u, ''),
        contextTruncated: message.text.length > 800,
        coverage: [],
      },
    };
  }
  const materialId = specification.source.materialId;
  const [material] = await tx
    .select({ state: materialVersions.state })
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
        eq(messageMaterials.messageId, source.messageId),
        eq(messageMaterials.contentVersion, source.contentVersion),
        eq(messageMaterials.materialId, materialId),
      ),
    )
    .limit(1);
  if (!material) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
  if (material.state === 'pending')
    return { state: 'waiting', reason: 'activity_material_pending' };
  if (material.state === 'unavailable')
    return { state: 'blocked', reason: 'activity_material_unavailable' };
  const rows = await tx
    .select({
      position: materialParts.position,
      page: materialParts.page,
      status: materialParts.status,
      text: materialParts.text,
    })
    .from(materialParts)
    .where(
      and(
        eq(materialParts.ownerId, ownerId),
        eq(materialParts.materialId, materialId),
        between(materialParts.position, specification.range.from, specification.range.through),
      ),
    )
    .orderBy(asc(materialParts.position));
  if (rows.length !== specification.range.through - specification.range.from + 1)
    return { state: 'blocked', reason: 'activity_material_range_missing' };
  const excerpts: NonNullable<ActivityPreparation['excerpts']> = [];
  const coverage: ActivityCoverage[] = [];
  for (const { position, page, status, text } of rows) {
    const clipped = text?.slice(0, 240).replace(/[\uD800-\uDBFF]$/u, '');
    if (status === 'text' && clipped) {
      excerpts.push({ position, text: clipped });
      coverage.push({
        position,
        page,
        status: clipped.length < text!.length ? 'truncated' : 'included',
      });
    } else {
      coverage.push({ position, page, status: status === 'image' ? 'image' : 'no-text-layer' });
    }
  }
  if (!excerpts.length) return { state: 'blocked', reason: 'activity_material_no_text' };
  return { state: 'ready', preparation: { excerpts, coverage } };
}
