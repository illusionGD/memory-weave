import { z } from 'zod';
import { API_CODES, utcDateTimeSchema, uuidSchema } from '@memory-weave/contracts';
import { ApiException } from '../../http/api-exception';
import { fingerprint } from '../shared/http';
const cursorSchema = z
  .object({
    v: z.literal(1),
    scope: z.string().length(64),
    asOf: utcDateTimeSchema,
    time: utcDateTimeSchema,
    id: uuidSchema,
  })
  .strict();
export type ExplorerCursor = z.infer<typeof cursorSchema>;
/** 游标只控制分页，不授予访问权；每页仍重新校验实际范围与生命周期。 */
export function readExplorerCursor(
  value: string | undefined,
  scope: unknown,
  now: Date,
): ExplorerCursor | null {
  if (!value) return null;
  try {
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    if (
      cursor.scope !== fingerprint(scope) ||
      new Date(cursor.asOf) > now ||
      cursor.time > cursor.asOf
    )
      throw new Error('invalid');
    return cursor;
  } catch {
    throw new ApiException(API_CODES.INVALID_REQUEST, '分页条件已变化或游标无效，请刷新后重试。');
  }
}
/** 复合排序键避免同一毫秒内的版本遗漏。 */
export function writeExplorerCursor(
  scope: unknown,
  asOf: string,
  time: string,
  id: string,
): string {
  return Buffer.from(JSON.stringify({ v: 1, scope: fingerprint(scope), asOf, time, id })).toString(
    'base64url',
  );
}
