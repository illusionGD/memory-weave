import { and, count, eq, getTableColumns, is, isNull, SQL } from 'drizzle-orm';
import type {
  MySqlInsertValue,
  MySqlTable,
  MySqlUpdateSetSource,
  SelectedFields,
} from 'drizzle-orm/mysql-core';
import { MySqlTransaction } from 'drizzle-orm/mysql-core';
import type { ResultSetHeader } from 'mysql2';
import type {
  Fields,
  SelectedRow,
  FindManyOptions,
  FindOneOptions,
  InsertValues,
  QueryConnection,
  ScopeKey,
  UpdateOptions,
  Where,
} from './crud-types';

/** 表的日常访问能力；业务清理另行显式授权。 */
export type TableAccess = 'read' | 'append' | 'write' | 'cleanup';

/** 在指定连接和归属内执行一次表操作，根入口可在此检查就绪状态。 */
export type TableExecutor<C extends QueryConnection> = <R>(
  operation: (db: C, ownerId: string) => Promise<R>,
) => Promise<R>;

/** 定义表的访问能力，供数据库入口组合普通连接或事务连接。 */
export function defineTable<T extends MySqlTable, K extends ScopeKey<T>, A extends TableAccess>(
  table: T,
  options: { scope: K; access: A },
) {
  /** 创建保留字段推导和操作能力的表访问对象。 */
  function connect<C extends QueryConnection>(execute: TableExecutor<C>) {
    const repo = new TableRepository(table, options.scope, execute, options.access);
    return repo as Pick<
      TableRepository<T, K, C>,
      | 'findOne'
      | 'findMany'
      | 'exists'
      | 'count'
      | (A extends 'read' ? never : 'insert' | 'insertMany')
      | (A extends 'write' | 'cleanup' ? 'updateWhere' : never)
      | (A extends 'cleanup' ? 'deleteWhere' : never)
    >;
  }
  return { connect };
}

/** 使用同一数据库连接执行表的基础读写操作。 */
class TableRepository<T extends MySqlTable, K extends ScopeKey<T>, C extends QueryConnection> {
  private readonly columns;

  /** 保存表定义、访问能力和取得当前连接的执行器。 */
  constructor(
    private readonly table: T,
    private readonly scope: K,
    private readonly execute: TableExecutor<C>,
    private readonly access: TableAccess,
  ) {
    this.columns = getTableColumns(table);
  }

  /** 查询一条记录，缺失时返回 null，并按投影推导类型。 */
  async findOne<const F extends Fields<T> = T['_']['columns']>(
    options: FindOneOptions<T, K, F, C> = {},
  ): Promise<SelectedRow<T, F> | null> {
    const rows = await this.findMany({ ...options, limit: 1 });
    return rows[0] ?? null;
  }

  /** 按筛选、排序和条数读取列表，不额外统计或回读。 */
  async findMany<const F extends Fields<T> = T['_']['columns']>(
    options: FindManyOptions<T, K, F, C>,
  ): Promise<SelectedRow<T, F>[]> {
    return this.execute(async (db, ownerId) => {
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
  async insert(values: InsertValues<T, K>): Promise<ResultSetHeader> {
    return this.insertMany([values]);
  }

  /** 用一条插入语句保存一批记录，保留数据库默认值和约束。 */
  async insertMany(values: readonly InsertValues<T, K>[]): Promise<ResultSetHeader> {
    return this.execute(async (db, ownerId) => {
      this.assertAccess('insert');
      if (!values.length) throw new TypeError('批量插入不能为空。');
      const scoped = values.map((value) => {
        if (Object.hasOwn(value, this.scope)) throw new TypeError('不能指定或修改绑定的归属字段。');
        return { ...value, [this.scope]: ownerId } as MySqlInsertValue<T>;
      });
      const [result] = await db.insert(this.table).values(scoped);
      return result;
    });
  }

  /** 判断范围内是否存在匹配记录，只读取一条标识。 */
  async exists(where?: Where<T, K>): Promise<boolean> {
    return this.execute(async (db, ownerId) => {
      const rows = await db
        .select({ present: this.columns[this.scope]! })
        .from(this.table)
        .where(this.condition(where, ownerId))
        .limit(1);
      return rows.length > 0;
    });
  }

  /** 由数据库统计匹配记录数量，不载入记录正文。 */
  async count(where?: Where<T, K>): Promise<number> {
    return this.execute(async (db, ownerId) => {
      const [row] = await db
        .select({ total: count() })
        .from(this.table)
        .where(this.condition(where, ownerId));
      return row!.total;
    });
  }

  /** 按明确条件原子更新，返回驱动的受影响行数供领域判断。 */
  async updateWhere(options: UpdateOptions<T, K>): Promise<ResultSetHeader> {
    return this.execute(async (db, ownerId) => {
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
  async deleteWhere(where: Where<T, K>): Promise<ResultSetHeader> {
    return this.execute(async (db, ownerId) => {
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
