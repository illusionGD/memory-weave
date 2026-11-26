import type {
  RelationshipDocument,
  RelationshipEvidence,
  RelationshipKind,
} from '@memory-weave/contracts';
import type { MemoryInputMessage } from '../memories/memory-types';
import type { RelationshipCandidate } from './relationship-definition';

/** 同一会话中经过读取校验的文字，不含原件和其他会话内容。 */
export type RelationshipSource = Pick<
  MemoryInputMessage,
  'messageId' | 'contentVersion' | 'sequence' | 'text' | 'target' | 'publishedAt' | 'epistemic'
> & { speakerMembershipId: string };

export interface ValidatedRelationship {
  kind: RelationshipKind;
  counterpartMembershipId: string;
  topic: string;
  document: RelationshipDocument;
  evidence: RelationshipEvidence[];
  lastSequence: number;
  observedAt: Date;
}

/** 逐字校验新证据与参与者，无法确定来源或归属的候选不写入状态。 */
export function validateRelationship(
  candidate: RelationshipCandidate,
  selfId: string,
  counterpartIds: Set<string>,
  sources: RelationshipSource[],
): ValidatedRelationship | null {
  const {
    counterpartMembershipId: counterpart,
    kind,
    topic,
    description,
    reason,
    provenance,
  } = candidate;
  if (!counterpartIds.has(counterpart) || counterpart === selfId) return null;
  const emotion = kind === 'self_emotion' || kind === 'observed_emotion';
  if (emotion !== (topic === 'current')) return null;
  if ((kind === 'agreement') !== (provenance === 'mutual')) return null;
  const refs = candidate.evidence.map((ref) => {
    const source = sources.find(
      (source) =>
        source.messageId === ref.messageId &&
        source.contentVersion === ref.contentVersion &&
        (source.speakerMembershipId === selfId || source.speakerMembershipId === counterpart),
    );
    if (!source) return null;
    const startOffset = source.text.indexOf(ref.quote);
    if (startOffset === -1) return null;
    return { source, startOffset, endOffset: startOffset + ref.quote.length };
  });
  const valid = refs.filter((ref) => ref !== null);
  if (valid.length !== refs.length || !valid.some(({ source }) => source.target)) return null;
  const expressed = new Set(
    valid
      .filter(({ source }) => source.epistemic === 'statement')
      .map(({ source }) => source.speakerMembershipId),
  );
  if (kind === 'agreement' && (!expressed.has(selfId) || !expressed.has(counterpart))) return null;
  if (kind === 'own_preference' && (provenance !== 'expression' || !expressed.has(selfId)))
    return null;
  if (kind === 'other_preference' && (provenance !== 'expression' || !expressed.has(counterpart)))
    return null;
  if (kind === 'self_emotion' && provenance === 'expression' && !expressed.has(selfId)) return null;
  if (kind === 'observed_emotion' && provenance === 'expression' && !expressed.has(counterpart))
    return null;
  const evidence = valid.map(({ source, startOffset, endOffset }) => ({
    messageId: source.messageId,
    contentVersion: source.contentVersion,
    sequence: source.sequence,
    speakerMembershipId: source.speakerMembershipId,
    startOffset,
    endOffset,
  }));
  const latest = valid.reduce((latest, item) =>
    item.source.sequence > latest.source.sequence ? item : latest,
  );
  return {
    kind,
    counterpartMembershipId: counterpart,
    topic,
    document: { description, reason, provenance },
    evidence: Array.from(
      new Map(
        evidence.map((ref) => [`${ref.messageId}:${ref.startOffset}:${ref.endOffset}`, ref]),
      ).values(),
    ),
    lastSequence: latest.source.sequence,
    observedAt: new Date(latest.source.publishedAt),
  };
}
