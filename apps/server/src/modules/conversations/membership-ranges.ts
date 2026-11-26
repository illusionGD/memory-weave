export interface SequenceRange {
  startSequence: number;
  endSequence: number | null;
}

/** 用不相交区间保存同一来源类型的实际授权。空区间可在没有新发言时出现。 */
export function mergeMembershipRanges(ranges: SequenceRange[]): SequenceRange[] {
  const ordered = ranges
    .filter(
      ({ startSequence, endSequence }) => endSequence === null || endSequence >= startSequence,
    )
    .sort((first, second) => first.startSequence - second.startSequence);
  const result: SequenceRange[] = [];
  for (const range of ordered) {
    const last = result.at(-1);
    if (!last || (last.endSequence !== null && range.startSequence > last.endSequence + 1)) {
      result.push({ ...range });
    } else if (last.endSequence !== null) {
      last.endSequence =
        range.endSequence === null ? null : Math.max(last.endSequence, range.endSequence);
    }
  }
  return result;
}

/** 退出保存已发生的边界，下一次入群不会补齐缺席区间。 */
export function closeMembershipRange(range: SequenceRange, leftSequence: number): SequenceRange {
  return {
    startSequence: range.startSequence,
    endSequence: Math.min(range.endSequence ?? leftSequence, leftSequence),
  };
}
