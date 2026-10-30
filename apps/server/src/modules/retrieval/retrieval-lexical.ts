import { eq } from 'drizzle-orm';
import type { MemoryDocument } from '@memory-weave/contracts';
import type { DatabaseTransaction } from '../../database/database.service';
import { memorySearchDocuments, memorySearchTerms } from '../../database/schema';

/** 固定分词版本，升级需重建派生词项；不覆盖权威正文。 */
export const LEXICAL_VERSION = 'zh-segment-bigram-v1';
const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });
const STOP_WORDS = new Set([
  '的',
  '了',
  '是',
  '我',
  '你',
  '它',
  '他',
  '她',
  '吗',
  '呢',
  '啊',
  '在',
  '和',
  '就',
  '把',
  '给',
  '有',
  '一个',
  '这个',
  '那个',
  '什么',
  '怎么',
]);
/** 中文词语与双字片段并行，数字和英文专名保留完整路径，词项有界。 */
export function lexicalTerms(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const terms = new Set<string>();
  for (const part of SEGMENTER.segment(normalized))
    if (part.isWordLike && !STOP_WORDS.has(part.segment) && part.segment.length <= 96)
      terms.add(part.segment);
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const chars = Array.from(match[0]);
    for (let i = 0; i < chars.length - 1; i++) terms.add(chars[i]! + chars[i + 1]!);
  }
  return [...terms].slice(0, 512);
}
/** 原文提交记忆版本的同一事务登记词法和待索引身份。 */
export async function registerSearchDocument(
  ownerId: string,
  versionId: string,
  memoryId: string,
  scope: { companionId: string; runtimeEpoch: number; conversationId: string },
  document: MemoryDocument,
  tx: DatabaseTransaction,
): Promise<void> {
  await tx
    .insert(memorySearchDocuments)
    .values({ ownerId, versionId, memoryId, ...scope, lexicalVersion: LEXICAL_VERSION })
    .onDuplicateKeyUpdate({ set: { lexicalVersion: LEXICAL_VERSION } });
  await tx.delete(memorySearchTerms).where(eq(memorySearchTerms.versionId, versionId));
  const terms = lexicalTerms(
    [document.text, document.subject.name, document.eventTime, document.storyKey]
      .filter(Boolean)
      .join(' '),
  );
  if (terms.length)
    await tx.insert(memorySearchTerms).values(terms.map((term) => ({ ownerId, versionId, term })));
}
