import { expectTypeOf } from 'vitest';
import type { Database, DatabaseTransaction } from '../../src/database/database.service';
import { conversations, personaTemplateVersions } from '../../src/database/schema';
import { defineTable } from '../../src/database/table-repository';

/** 核对调用方能获得表字段、值类型、投影和访问能力的编译期约束；仅由 tsc 检查。 */
export async function checkRepositoryTypes(
  db: Database,
  tx: DatabaseTransaction,
  ownerId: string,
): Promise<void> {
  const table = defineTable(conversations, { scope: 'ownerId', access: 'write' });
  const rows = table.bind(db, ownerId);
  const full = await rows.findOne({ where: { kind: 'private', lifecycleOperationId: null } });
  expectTypeOf(full).toEqualTypeOf<typeof conversations.$inferSelect | null>();
  const partial = await rows.findMany({
    fields: { label: conversations.title, at: conversations.createdAt },
    limit: 20,
  });
  expectTypeOf(partial).toEqualTypeOf<{ label: string; at: Date }[]>();
  // @ts-expect-error 投影中未选择 ownerId，不应暴露该属性。
  void partial[0]!.ownerId;
  // @ts-expect-error 拼错的字段应在编译期报错。
  await rows.findOne({ where: { titlle: '错字' } });
  // @ts-expect-error 字段值仍是 private/group 联合类型。
  await rows.findOne({ where: { kind: 'other' } });
  // @ts-expect-error 条件字段 version 不接受字符串。
  await rows.findOne({ where: { version: '2' } });
  // @ts-expect-error 更新字段 title 不接受数字。
  await rows.updateWhere({ where: { id: 'id' }, set: { title: 42 } });
  // @ts-expect-error 更新必须有明确的 where。
  await rows.updateWhere({ set: { title: '缺失条件' } });
  // @ts-expect-error 归属字段由绑定入口持有。
  await rows.updateWhere({ where: { id: 'id' }, set: { ownerId } });
  // @ts-expect-error 插入仍要求 title 等必填业务字段。
  await rows.insert({ kind: 'private' });
  // @ts-expect-error 普通连接不能请求行锁。
  await rows.findOne({ where: { id: 'id' }, lock: 'update' });
  await table.bind(tx, ownerId).findOne({ where: { id: 'id' }, lock: 'update' });
  // @ts-expect-error 日常写入入口不提供物理删除。
  await rows.deleteWhere({ id: 'id' });
  const history = defineTable(personaTemplateVersions, { scope: 'ownerId', access: 'append' }).bind(
    tx,
    ownerId,
  );
  // @ts-expect-error 版本表仅开放读取和追加。
  await history.updateWhere({ where: { id: 'id' }, set: { name: '改写历史' } });
}
