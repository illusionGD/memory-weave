import type { MemoryDocument } from '@memory-weave/contracts';

/** 单条经历是最小归档单位，保留整句，只折叠逐字重复的完整句子。 */
export function compressExperience(document: MemoryDocument): string | null {
  const complete = document.text.match(/[^。！？!?\n]+(?:[。！？!?]+|\n|$)/gu);
  if (!complete || complete.join('') !== document.text) return null;
  const unique = [...new Set(complete.map((sentence) => sentence.trim()).filter(Boolean))];
  const summary = unique.join('');
  return summary.length > 0 && summary.length < document.text.length * 0.85 ? summary : null;
}
