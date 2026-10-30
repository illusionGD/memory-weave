import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { LifecycleRecord } from './lifecycle-cleanup';

/** v3 在命令时限制所有可能跨私聊依赖的会话；旧协议仍只使用原会话。 */
export function lifecycleConversationScope(column: unknown, operation: LifecycleRecord): SQL {
  return operation.protocolVersion >= 3
    ? sql`${column} IN (SELECT id FROM conversations WHERE owner_id = ${operation.ownerId} AND lifecycle_operation_id = ${operation.id})`
    : sql`${column} = ${operation.conversationId}`;
}
