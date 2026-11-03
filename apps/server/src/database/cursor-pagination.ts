/** 根据多读取的一条记录生成 ID 游标页，保持调用方已有的排序。 */
export function idCursorPage<T>(
  rows: readonly T[],
  limit: number,
  key: (row: T) => string,
): { items: T[]; nextAfterId: string | null } {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('分页条数必须是正整数。');
  const items = rows.slice(0, limit);
  return { items, nextAfterId: rows.length > limit ? key(items.at(-1)!) : null };
}
