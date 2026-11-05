import type { SelectResultFields } from 'drizzle-orm/query-builders/select.types';
import type { SQL } from 'drizzle-orm';
import type {
  MySqlColumn,
  MySqlInsertValue,
  MySqlTable,
  MySqlUpdateSetSource,
  SelectedFields,
} from 'drizzle-orm/mysql-core';
import type { SqlDatabase, SqlTransaction } from './database.service';

/** 表访问复用的普通连接或当前事务。 */
export type QueryConnection = SqlDatabase | SqlTransaction;
/** 可作为部署归属的字符串字段。 */
export type ScopeKey<T extends MySqlTable> = {
  [K in keyof T['$inferSelect']]: T['$inferSelect'][K] extends string ? K : never;
}[keyof T['$inferSelect']] &
  string;
/** 类型化等值条件或 Drizzle 表达式；归属条件由绑定入口追加。 */
export type Where<T extends MySqlTable, K extends ScopeKey<T>> =
  Partial<Omit<T['$inferSelect'], K>> | SQL;
/** 插入时自动附加归属，调用方不能覆盖该字段。 */
export type InsertValues<T extends MySqlTable, K extends ScopeKey<T>> = Omit<
  MySqlInsertValue<T>,
  K
> & {
  [P in K]?: never;
};
/** 可用字段名数组，也可使用带别名的 Drizzle 投影。 */
export type Fields<T extends MySqlTable> =
  SelectedFields | readonly (keyof T['$inferSelect'] & string)[];
/** 按实际字段投影推导查询结果。 */
export type SelectedRow<
  T extends MySqlTable,
  F extends Fields<T>,
> = F extends readonly (keyof T['$inferSelect'])[]
  ? Pick<T['$inferSelect'], F[number]>
  : F extends SelectedFields
    ? { -readonly [P in keyof SelectResultFields<F>]: SelectResultFields<F>[P] }
    : never;
/** 查询一行的筛选与投影。 */
export interface FindOneOptions<
  T extends MySqlTable,
  K extends ScopeKey<T>,
  F extends Fields<T>,
  C extends QueryConnection = QueryConnection,
> {
  /** 不传条件时只限定当前归属。 */
  where?: Where<T, K>;
  /** 按实际选取的列与别名推导返回类型。 */
  fields?: F;
  /** 只有绑定事务后才能请求行锁。 */
  lock?: C extends SqlTransaction ? 'update' | 'share' : never;
}

/** 有界列表查询；不提供偏移分页，调用方继续使用原有游标条件。 */
export interface FindManyOptions<
  T extends MySqlTable,
  K extends ScopeKey<T>,
  F extends Fields<T>,
  C extends QueryConnection = QueryConnection,
> extends FindOneOptions<T, K, F, C> {
  /** 必须显式给出需要的条数，避免默认读取整表。 */
  limit: number;
  /** 使用 Drizzle 的排序表达式，保留复合游标的稳定顺序。 */
  orderBy?: readonly (SQL | MySqlColumn)[];
}

/** 更新只接受当前表可写字段，并禁止改变绑定归属。 */
export type UpdateValues<T extends MySqlTable, K extends ScopeKey<T>> = Omit<
  MySqlUpdateSetSource<T>,
  K
> & { [P in K]?: never };
/** 更新必须明确给出筛选和修改内容。 */
export interface UpdateOptions<T extends MySqlTable, K extends ScopeKey<T>> {
  /** 原子更新条件，可包含预期版本或租约状态。 */
  where: Where<T, K>;
  /** 同一条 UPDATE 中提交的字段或 SQL 表达式。 */
  set: UpdateValues<T, K>;
}
