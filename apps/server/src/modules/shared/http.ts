import { ApiErrorCode } from '@memory-weave/contracts';
import { createHash } from 'node:crypto';
import { ApiException } from '../../http/api-exception';
import { z } from 'zod';

/**
 * 按公共契约校验外部输入，错误响应不回显原始字段或敏感内容。
 * @param schema 请求参数对应的校验规则。
 * @param value 尚未校验的请求数据。
 * @returns 经过校验并应用默认值的参数。
 */
export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiException(ApiErrorCode.INVALID_REQUEST);
  return result.data;
}

/**
 * 校验路径中的稳定标识，避免无效值进入数据库查询。
 * @param value 路由参数中的标识。
 * @returns 合法的 UUID。
 */
export function parseId(value: string): string {
  return parseInput(z.uuid(), value);
}

/**
 * 对已校验请求计算稳定指纹，用于识别幂等键是否被用于不同内容。
 * @param value 由公共契约解析得到的可序列化数据。
 * @returns 不包含请求原文的 SHA-256 指纹。
 */
export function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

/** 将对象字段排序，保留数组次序，避免 JSON 字段排列影响幂等判断。 */
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
