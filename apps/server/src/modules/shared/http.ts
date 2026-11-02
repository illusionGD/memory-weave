import { createHash } from 'node:crypto';

/**
 * 计算请求内容的稳定指纹。
 *
 * 对已校验请求计算稳定指纹，用于识别幂等键是否被用于不同内容。
 * @param value 由公共契约解析得到的可序列化数据。
 * @returns 不包含请求原文的 SHA-256 指纹。
 */
export function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

/**
 * 递归规范化对象字段顺序。
 *
 * 将对象字段排序，保留数组次序，避免 JSON 字段排列影响幂等判断。
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}
