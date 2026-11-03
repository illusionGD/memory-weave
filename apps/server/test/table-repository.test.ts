import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import type { Pool } from 'mysql2/promise';
import { createPool } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mysqlConnectionOptions } from '../src/database/connection';
import type { Database } from '../src/database/database.service';
import * as schema from '../src/database/schema';
import { defineTable } from '../src/database/table-repository';
import type { TestDatabase } from './support/database';
import { createTestDatabase } from './support/database';

const conversationTable = defineTable(schema.conversations, { scope: 'ownerId', access: 'write' });

describe('类型化表访问入口连接真实 MySQL', () => {
  let database: TestDatabase;
  let pool: Pool;
  let db: Database;
  let ownerId: string;
  const statements: string[] = [];
  const otherOwner = randomUUID();

  beforeAll(async () => {
    database = await createTestDatabase();
    pool = createPool(mysqlConnectionOptions(database.databaseUrl));
    db = drizzle(pool, {
      schema,
      mode: 'default',
      logger: {
        /** 记录 SQL 条数，用于核对批量写入与查询没有隐式回读。 */
        logQuery(query: string) {
          statements.push(query);
        },
      },
    });
    const [owner] = await db
      .select()
      .from(schema.owners)
      .where(eq(schema.owners.deploymentKey, 'local'));
    ownerId = owner!.id;
    await db.insert(schema.owners).values({ id: otherOwner, deploymentKey: 'repository-test' });
  });
  afterAll(async () => {
    await pool?.end();
    await database?.dispose();
  });

  it('创建后按同一归属读取默认值，其他归属不能读取或通过 SQL 条件绕过隔离', async () => {
    const id = randomUUID();
    const repo = conversationTable.bind(db, ownerId);
    await repo.insert({
      id,
      title: '散步计划',
      kind: 'private',
      requestId: randomUUID(),
      fingerprint: 'initial',
    });
    expect(await repo.findOne({ where: { id } })).toMatchObject({
      id,
      ownerId,
      title: '散步计划',
      version: 1,
      lastSequence: 0,
      lifecycleOperationId: null,
    });
    expect(await conversationTable.bind(db, otherOwner).findOne({ where: { id } })).toBeNull();
    expect(
      await conversationTable
        .bind(db, otherOwner)
        .findOne({ where: eq(schema.conversations.id, id) }),
    ).toBeNull();
    expect(await repo.findOne({ where: { id: randomUUID() } })).toBeNull();
  });
  it('批量插入后按 nullable 条件分页，投影保留别名和真实字段类型', async () => {
    const repo = conversationTable.bind(db, otherOwner);
    const a = randomUUID();
    const b = randomUUID();
    const beforeInsert = statements.length;
    await repo.insertMany([
      { id: a, title: 'A. 山间', kind: 'private', requestId: randomUUID(), fingerprint: 'batch-a' },
      { id: b, title: 'B. 海边', kind: 'group', requestId: randomUUID(), fingerprint: 'batch-b' },
    ]);
    expect(statements.slice(beforeInsert)).toHaveLength(1);
    expect(statements.at(-1)).toMatch(/^insert into /);
    const fields = {
      conversationId: schema.conversations.id,
      title: schema.conversations.title,
      created: schema.conversations.createdAt,
    };
    const beforeQuery = statements.length;
    const selected = await repo.findMany({
      where: { lifecycleOperationId: null },
      fields,
      orderBy: [asc(schema.conversations.title)],
      limit: 1,
    });
    expect(statements.slice(beforeQuery)).toHaveLength(1);
    expect(selected).toEqual([{ conversationId: a, title: 'A. 山间', created: expect.any(Date) }]);
    expect(
      await repo.findOne({ where: { id: b }, fields: { kind: schema.conversations.kind } }),
    ).toEqual({ kind: 'group' });
  });

  it('更新保留原子版本条件，拒绝空条件和归属覆盖，清理仅删除指定归属的记录', async () => {
    const id = randomUUID();
    const repo = conversationTable.bind(db, ownerId);
    await repo.insert({
      id,
      title: '更新前',
      kind: 'private',
      requestId: randomUUID(),
      fingerprint: 'mutation',
    });
    expect(
      (await repo.updateWhere({ where: { id, version: 1 }, set: { title: '更新后', version: 2 } }))
        .affectedRows,
    ).toBe(1);
    expect(
      (await repo.updateWhere({ where: { id, version: 1 }, set: { title: '过期更新' } }))
        .affectedRows,
    ).toBe(0);
    await expect(repo.updateWhere({ where: {}, set: { title: '误改整表' } })).rejects.toThrow();
    await expect(
      repo.updateWhere({ where: { id: undefined }, set: { title: '误改整表' } }),
    ).rejects.toThrow();
    await expect(
      repo.updateWhere({ where: { id }, set: { ownerId: otherOwner } as never }),
    ).rejects.toThrow();
    expect(await repo.count({ id })).toBe(1);
    expect((await repo.findOne({ where: { id } }))?.title).toBe('更新后');
    const cleanup = defineTable(schema.conversations, { scope: 'ownerId', access: 'cleanup' });
    expect((await cleanup.bind(db, otherOwner).deleteWhere({ id })).affectedRows).toBe(0);
    await expect(cleanup.bind(db, ownerId).deleteWhere({})).rejects.toThrow();
    expect(await repo.exists({ id })).toBe(true);
    expect((await cleanup.bind(db, ownerId).deleteWhere({ id })).affectedRows).toBe(1);
    expect(await repo.exists({ id })).toBe(false);
    expect(await repo.count({ id })).toBe(0);
  });

  it('事务内立即读到新增记录，抛错后全部回滚，普通连接不能请求行锁', async () => {
    const id = randomUUID();
    await expect(
      db.transaction(
        async (tx) => {
          const repo = conversationTable.bind(tx, ownerId);
          await repo.insert({
            id,
            title: '尚未提交',
            kind: 'private',
            requestId: randomUUID(),
            fingerprint: 'rollback',
          });
          expect((await repo.findOne({ where: { id }, lock: 'update' }))?.title).toBe('尚未提交');
          await repo.updateWhere({ where: { id }, set: { title: '仍须回滚' } });
          throw new Error('触发回滚');
        },
        { isolationLevel: 'read committed' },
      ),
    ).rejects.toThrow('触发回滚');
    expect(await conversationTable.bind(db, ownerId).exists({ id })).toBe(false);
    await expect(
      conversationTable.bind(db, ownerId).findOne({ where: { id }, lock: 'update' } as never),
    ).rejects.toThrow('行锁');
  });

  it('即使绕过编译期检查也不能覆盖归属或扩大只读、只追加入口的权限', async () => {
    const repo = conversationTable.bind(db, ownerId);
    const input = {
      id: randomUUID(),
      title: '只追加记录',
      kind: 'private' as const,
      requestId: randomUUID(),
      fingerprint: 'access',
    };
    await expect(repo.insert({ ...input, ownerId: otherOwner } as never)).rejects.toThrow('归属');
    const readOnly = defineTable(schema.conversations, { scope: 'ownerId', access: 'read' }).bind(
      db,
      ownerId,
    );
    await expect((readOnly as typeof repo).insert(input)).rejects.toThrow('未开放');
    const appendOnly = defineTable(schema.conversations, {
      scope: 'ownerId',
      access: 'append',
    }).bind(db, ownerId);
    await appendOnly.insert(input);
    await expect(
      (appendOnly as typeof repo).updateWhere({ where: { id: input.id }, set: { title: '覆盖' } }),
    ).rejects.toThrow('未开放');
    expect((await readOnly.findOne({ where: { id: input.id } }))?.title).toBe(input.title);
    await expect(repo.findMany({ limit: 0 })).rejects.toThrow('正整数');
    await expect(repo.findMany({ limit: Number.POSITIVE_INFINITY })).rejects.toThrow('正整数');
  });
});
