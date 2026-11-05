import { and, count, eq, getTableColumns, is, isNull, SQL } from 'drizzle-orm';
import type {
  MySqlColumn,
  MySqlInsertValue,
  MySqlTable,
  MySqlUpdateSetSource,
  SelectedFields,
} from 'drizzle-orm/mysql-core';
import { MySqlTransaction } from 'drizzle-orm/mysql-core';
import { API_CODES } from '@memory-weave/contracts';
import { ApiException, databaseOperation } from '../http/api-exception';
import type { Database, DatabaseTransaction, QueryDatabase } from './database.service';
import type { SelectResultFields } from 'drizzle-orm/query-builders/select.types';
import type { ResultSetHeader } from 'mysql2';

/** 可作为部署归属的字符串字段。 */
export type ScopeKey<T extends MySqlTable> = keyof T['$inferSelect'] & string;
/** 类型化等值条件或 Drizzle 表达式；归属条件由显式 ownerId 参数追加。 */
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
export interface FindOneOptions<T extends MySqlTable, K extends ScopeKey<T>, F extends Fields<T>> {
  /** 不传条件时只限定当前归属。 */
  where?: Where<T, K>;
  /** 按实际选取的列与别名推导返回类型。 */
  fields?: F;
  /** 原生排序表达式，用于稳定地选择第一条记录。 */
  orderBy?: readonly (SQL | MySqlColumn)[];
  /** 请求行锁时必须显式传入当前事务。 */
  lock?: 'update' | 'share';
}

/** 有界列表查询；不提供偏移分页，调用方继续使用原有游标条件。 */
export interface FindManyOptions<
  T extends MySqlTable,
  K extends ScopeKey<T>,
  F extends Fields<T>,
> extends FindOneOptions<T, K, F> {
  /** 必须显式给出需要的条数，避免默认读取整表。 */
  limit: number;
}

/** 更新只接受当前表可写字段，并禁止改变记录归属。 */
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

/** 表的日常访问能力；业务清理另行显式授权。 */
export type TableAccess = 'read' | 'append' | 'write' | 'cleanup';

/** 使用同一数据库连接执行表的基础读写操作。 */
export class TableRepository<T extends MySqlTable, K extends ScopeKey<T>> {
  private readonly columns;

  /** 保存表、连接与写入能力；不保存当前用户，也不创建事务代理。 */
  constructor(
    private readonly table: T,
    private readonly scope: K,
    private readonly connection: Database,
    private readonly access: TableAccess,
    private readonly transactions: WeakSet<DatabaseTransaction>,
  ) {
    this.columns = getTableColumns(table);
  }

  /** 查询一条记录，缺失时返回 null，并按投影推导类型。 */
  async findOne<const F extends Fields<T> = T['_']['columns']>(
    ownerId: string,
    options: FindOneOptions<T, K, F> = {},
    db: QueryDatabase = this.connection,
  ): Promise<SelectedRow<T, F> | null> {
    const rows = await this.findMany(ownerId, { ...options, limit: 1 }, db);
    return rows[0] ?? null;
  }

  /** 按筛选、排序和条数读取列表，不额外统计或回读。 */
  async findMany<const F extends Fields<T> = T['_']['columns']>(
    ownerId: string,
    options: FindManyOptions<T, K, F>,
    db: QueryDatabase = this.connection,
  ): Promise<SelectedRow<T, F>[]> {
    this.assertConnection(ownerId, db);
    return databaseOperation(async () => {
      if (!Number.isSafeInteger(options.limit) || options.limit < 1)
        throw new TypeError('查询条数必须是正整数。');
      const query = db
        .select(this.selectFields(options.fields))
        .from(this.table)
        .where(this.condition(options.where, ownerId))
        .orderBy(...(options.orderBy ?? []))
        .limit(options.limit);
      if (options.lock) {
        if (!is(db, MySqlTransaction)) throw new TypeError('行锁只能用于当前事务。');
        query.for(options.lock);
      }
      const rows = await query;
      // Drizzle 的泛型 from 条件类型无法跨封装还原；投影与结果保持同一个 F。
      return rows as unknown as SelectedRow<T, F>[];
    });
  }

  /** 按主键读取同一用户的记录，缺失返回 null。 */
  findById(
    ownerId: string,
    id: string,
    db: QueryDatabase = this.connection,
  ): Promise<T['$inferSelect'] | null> {
    return this.findOne(ownerId, { where: eq(this.columns.id!, id) }, db);
  }

  /** 根据主键更新业务字段，归属仍由独立参数强制限定。 */
  update(
    ownerId: string,
    id: string,
    set: UpdateOptions<T, K>['set'],
    db: QueryDatabase = this.connection,
  ) {
    return this.updateWhere(ownerId, { where: eq(this.columns.id!, id), set }, db);
  }

  /** 拒绝缺失身份和已结束的事务，不从其他请求推断用户。 */
  private assertConnection(ownerId: string, db: QueryDatabase): void {
    if (!ownerId) throw new ApiException(API_CODES.AUTH_REQUIRED);
    if (is(db, MySqlTransaction) && !this.transactions.has(db as DatabaseTransaction))
      throw new TypeError('事务已结束或不属于当前数据库。');
  }

  /** 将字段名投影转换为查询列，拒绝空投影及不存在的字段。 */
  private selectFields(fields?: Fields<T>): SelectedFields {
    if (!fields) return this.columns;
    if (!Array.isArray(fields)) return fields as SelectedFields;
    if (!fields.length) throw new TypeError('查询字段不能为空。');
    const selected: SelectedFields = {};
    for (const name of fields) {
      if (!Object.hasOwn(this.columns, name)) throw new TypeError('查询字段不存在。');
      selected[name] = this.columns[name]!;
    }
    return selected;
  }

  /** 插入一条记录，附加固定归属，不额外查询或覆盖已有行。 */
  async insert(
    ownerId: string,
    values: InsertValues<T, K>,
    db: QueryDatabase = this.connection,
  ): Promise<ResultSetHeader> {
    return this.insertMany(ownerId, [values], db);
  }

  /** 用一条插入语句保存一批记录，保留数据库默认值和约束。 */
  async insertMany(
    ownerId: string,
    values: readonly InsertValues<T, K>[],
    db: QueryDatabase = this.connection,
  ): Promise<ResultSetHeader> {
    this.assertConnection(ownerId, db);
    return databaseOperation(async () => {
      this.assertAccess('insert');
      if (!values.length) throw new TypeError('批量插入不能为空。');
      const scoped = values.map((value) => {
        if (Object.hasOwn(value, this.scope)) throw new TypeError('不能指定或修改记录的归属字段。');
        return { ...value, [this.scope]: ownerId } as MySqlInsertValue<T>;
      });
      const [result] = await db.insert(this.table).values(scoped);
      return result;
    });
  }

  /** 判断范围内是否存在匹配记录，只读取一条标识。 */
  async exists(
    ownerId: string,
    where?: Where<T, K>,
    db: QueryDatabase = this.connection,
  ): Promise<boolean> {
    this.assertConnection(ownerId, db);
    return databaseOperation(async () => {
      const rows = await db
        .select({ present: this.columns[this.scope]! })
        .from(this.table)
        .where(this.condition(where, ownerId))
        .limit(1);
      return rows.length > 0;
    });
  }

  /** 由数据库统计匹配记录数量，不载入记录正文。 */
  async count(
    ownerId: string,
    where?: Where<T, K>,
    db: QueryDatabase = this.connection,
  ): Promise<number> {
    this.assertConnection(ownerId, db);
    return databaseOperation(async () => {
      const [row] = await db
        .select({ total: count() })
        .from(this.table)
        .where(this.condition(where, ownerId));
      return row!.total;
    });
  }

  /** 按明确条件原子更新，返回驱动的受影响行数供领域判断。 */
  async updateWhere(
    ownerId: string,
    options: UpdateOptions<T, K>,
    db: QueryDatabase = this.connection,
  ): Promise<ResultSetHeader> {
    this.assertConnection(ownerId, db);
    return databaseOperation(async () => {
      this.assertAccess('update');
      this.assertWriteWhere(options.where);
      if (!Object.keys(options.set).length || Object.hasOwn(options.set, this.scope))
        throw new TypeError('更新内容为空或试图修改数据归属。');
      for (const key of Object.keys(options.set)) {
        if (!Object.hasOwn(this.columns, key)) throw new TypeError('更新字段不存在。');
      }
      const [result] = await db
        .update(this.table)
        .set(options.set as MySqlUpdateSetSource<T>)
        .where(this.condition(options.where, ownerId));
      return result;
    });
  }

  /** 仅供显式清理入口物理删除明确条件下的记录。 */
  async deleteWhere(
    ownerId: string,
    where: Where<T, K>,
    db: QueryDatabase = this.connection,
  ): Promise<ResultSetHeader> {
    this.assertConnection(ownerId, db);
    return databaseOperation(async () => {
      this.assertAccess('delete');
      this.assertWriteWhere(where);
      const [result] = await db.delete(this.table).where(this.condition(where, ownerId));
      return result;
    });
  }

  /** 拒绝未给出具体条件的更新或删除。 */
  private assertWriteWhere(where: Where<T, K>): void {
    if (!where || (!is(where, SQL) && !Object.keys(where).length))
      throw new TypeError('更新和删除必须指定明确条件。');
  }

  /** 防止调用方绕过类型检查修改只读或只追加的数据。 */
  private assertAccess(operation: 'insert' | 'update' | 'delete'): void {
    if (
      this.access === 'read' ||
      (operation === 'update' && this.access === 'append') ||
      (operation === 'delete' && this.access !== 'cleanup')
    )
      throw new TypeError('当前表访问未开放该写入操作。');
  }

  /** 将等值对象或表达式与固定归属条件合并。 */
  private condition(where: Where<T, K> | undefined, ownerId: string): SQL {
    const scopeColumn = this.columns[this.scope]!;
    const scope = eq(scopeColumn, ownerId);
    if (where === undefined) return scope;
    if (is(where, SQL)) return and(scope, where)!;
    const conditions: SQL[] = [];
    for (const [key, value] of Object.entries(where)) {
      const column = this.columns[key];
      if (!Object.hasOwn(this.columns, key) || !column || key === this.scope || value === undefined)
        throw new TypeError('查询字段或条件值无效。');
      conditions.push(value === null ? isNull(column) : eq(column, value));
    }
    return and(scope, ...conditions)!;
  }
}
