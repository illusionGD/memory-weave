import type { MySqlTransactionConfig } from 'drizzle-orm/mysql-core';
import type { QueryConnection } from './crud-types';
import type { SqlTransaction } from './database.service';
import { DatabaseTables } from './tables';

/** 同时提供类型化表入口与显式 Drizzle 连接，每个上下文独立持有数据归属。 */
export class DatabaseContext<C extends QueryConnection> extends DatabaseTables<C> {
  /** 将表操作固定到当前连接，原始 SQL 与基础 CRUD 共用同一个事务。 */
  constructor(
    readonly sql: C,
    readonly ownerId: string,
  ) {
    super((operation) => operation(sql, ownerId));
    if (!ownerId) throw new TypeError('数据库入口必须指定数据归属。');
  }

  /** 创建独立的事务上下文，回调中的所有表操作使用同一个事务连接。 */
  transaction<R>(
    operation: (tx: DatabaseContext<SqlTransaction>) => Promise<R>,
    options?: MySqlTransactionConfig,
  ): Promise<R> {
    return this.sql.transaction((tx) => operation(new DatabaseContext(tx, this.ownerId)), options);
  }
}
