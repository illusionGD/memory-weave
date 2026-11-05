import type { MySqlTransactionConfig } from 'drizzle-orm/mysql-core';
import type { QueryConnection } from './crud-types';
import type { SqlTransaction } from './database.service';
import { DatabaseTables } from './tables';
import { databaseOperation } from '../http/api-exception';

/** 根入口创建事务时使用的公开回调签名。 */
export type TransactionRunner = <R>(
  operation: (tx: DatabaseContext<SqlTransaction>) => Promise<R>,
  options?: MySqlTransactionConfig,
) => Promise<R>;

/** 同时提供类型化表入口与显式 Drizzle 连接，每个上下文独立持有数据归属。 */
export class DatabaseContext<C extends QueryConnection> extends DatabaseTables<C> {
  private active = true;
  /** 将表操作固定到当前连接，原始 SQL 与基础 CRUD 共用同一个事务。 */
  constructor(
    private readonly connection: C,
    readonly ownerId: string,
    private readonly transact?: TransactionRunner,
  ) {
    super((operation) => databaseOperation(() => operation(this.sql, ownerId)));
    if (!ownerId) throw new TypeError('数据库入口必须指定数据归属。');
  }

  /** 取得仍在有效期内的连接，事务结束后拒绝继续查询。 */
  get sql(): C {
    if (!this.active) throw new Error('事务已经结束。');
    return this.connection;
  }

  /** 由事务执行器关闭访问，避免回调结束后继续使用旧连接。 */
  finish(): void {
    this.active = false;
  }

  /** 创建独立的事务上下文，回调中的所有表操作使用同一个事务连接。 */
  transaction<R>(
    operation: (tx: DatabaseContext<SqlTransaction>) => Promise<R>,
    options?: MySqlTransactionConfig,
  ): Promise<R> {
    if (!this.transact) throw new TypeError('请复用当前 tx，不要嵌套开启事务。');
    return this.transact(operation, options);
  }
}
