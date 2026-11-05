import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { LifecycleRecord } from './lifecycle-cleanup';

/**
 * 计算生命周期操作需要限制的会话范围。
 *
 * 命令时限制所有可能跨私聊依赖的会话，清理时始终使用这一固定范围。
 */
export function lifecycleConversationScope(column: unknown, operation: LifecycleRecord): SQL {
  return sql`${column} IN (SELECT id FROM conversations WHERE owner_id = ${operation.ownerId} AND lifecycle_operation_id = ${operation.id})`;
}
