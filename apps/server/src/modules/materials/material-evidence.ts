import type { MaterialEvidenceLocator } from '@memory-weave/contracts';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service';
import { materialParts, materialReadings, modelCalls } from '../../database/schema';
import type { MemoryInputMessage } from '../memories/memory-types';
import { perceptionOutputSchema } from './perception-definition';

/** 回查材料证据的当前文本，调用方已核对确切分享消息及其可见性。 */
export async function readMaterialEvidence(
  ownerId: string,
  locator: MaterialEvidenceLocator,
  tx: DatabaseTransaction,
): Promise<string | null> {
  if (locator.kind === 'material-text') {
    const [part] = await tx
      .select({ text: materialParts.text })
      .from(materialParts)
      .where(
        and(
          eq(materialParts.ownerId, ownerId),
          eq(materialParts.materialId, locator.materialId),
          eq(materialParts.position, locator.position),
        ),
      )
      .limit(1);
    return part?.text ?? null;
  }
  const [call] = await tx
    .select({ result: modelCalls.result })
    .from(modelCalls)
    .where(
      and(
        eq(modelCalls.ownerId, ownerId),
        eq(modelCalls.id, locator.modelCallId),
        isNull(modelCalls.invalidatedAt),
      ),
    )
    .limit(1);
  const value = perceptionOutputSchema.safeParse(
    call?.result?.kind === 'structured' ? call.result.value : null,
  );
  return value.success ? value.data.description : null;
}

/** 给整理批次准备已完成阅读的少量引用，不重新派发感知或把摘要当原件。 */
export async function materialEvidenceForMemory(
  ownerId: string,
  companionId: string,
  runtimeEpoch: number,
  messageId: string,
  contentVersion: number,
  tx: DatabaseTransaction,
): Promise<NonNullable<MemoryInputMessage['materials']>> {
  const readings = await tx
    .select()
    .from(materialReadings)
    .where(
      and(
        eq(materialReadings.ownerId, ownerId),
        eq(materialReadings.companionId, companionId),
        eq(materialReadings.runtimeEpoch, runtimeEpoch),
        eq(materialReadings.messageId, messageId),
        eq(materialReadings.contentVersion, contentVersion),
        eq(materialReadings.batch, 0),
        isNotNull(materialReadings.finishedAt),
      ),
    )
    .orderBy(desc(materialReadings.finishedAt))
    .limit(4);
  const locators: MaterialEvidenceLocator[] = [];
  for (const reading of readings) {
    if (reading.modelCallId && !reading.correctedByMessageId)
      locators.push({
        kind: 'image-observation',
        materialId: reading.materialId,
        modelCallId: reading.modelCallId,
      });
    for (const item of reading.excerpts) {
      if (!item.truncated)
        locators.push({
          kind: 'material-text',
          materialId: reading.materialId,
          position: item.position,
        });
    }
  }
  const distinct = [
    ...new Map(locators.map((locator) => [JSON.stringify(locator), locator])).values(),
  ].slice(0, 3);
  const values = await Promise.all(
    distinct.map(async (locator) => ({
      locator,
      text: await readMaterialEvidence(ownerId, locator, tx),
    })),
  );
  return values.flatMap(({ locator, text }) =>
    text ? [{ locator, text: text.slice(0, 1000) }] : [],
  );
}
