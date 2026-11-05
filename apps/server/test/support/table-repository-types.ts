import { expectTypeOf } from 'vitest';
import type { DatabaseService, DatabaseTransaction } from '../../src/database/database.service';
import { conversations } from '../../src/database/schema';

/** 核对调用方能获得表字段、值类型和投影的编译期约束；仅由 tsc 检查。 */
export async function checkRepositoryTypes(
  tx: DatabaseTransaction,
  ownerId: string,
  database: DatabaseService,
): Promise<void> {
  const direct = await database.conversations.findOne(ownerId, {
    fields: { name: conversations.title },
  });
  expectTypeOf(direct).toEqualTypeOf<{ name: string } | null>();
  const named = await database.conversations.findMany(ownerId, {
    fields: ['id', 'title'],
    limit: 20,
  });
  expectTypeOf(named).toEqualTypeOf<{ id: string; title: string }[]>();
  // @ts-expect-error 字段名投影也拒绝不存在的列。
  await database.conversations.findOne(ownerId, { fields: ['titlle'] });
  // 连接和表访问能力在运行时校验，避免通过多层泛型维护两个接口。
  await database.conversations.findOne(ownerId, { lock: 'update' });
  const rows = database.conversations;
  const full = await rows.findOne(ownerId, {
    where: { kind: 'private', lifecycleOperationId: null },
  });
  expectTypeOf(full).toEqualTypeOf<typeof conversations.$inferSelect | null>();
  const partial = await rows.findMany(ownerId, {
    fields: { label: conversations.title, at: conversations.createdAt },
    limit: 20,
  });
  expectTypeOf(partial).toEqualTypeOf<{ label: string; at: Date }[]>();
  // @ts-expect-error 投影中未选择 ownerId，不应暴露该属性。
  void partial[0]!.ownerId;
  // @ts-expect-error 拼错的字段应在编译期报错。
  await rows.findOne(ownerId, { where: { titlle: '错字' } });
  // @ts-expect-error 字段值仍是 private/group 联合类型。
  await rows.findOne(ownerId, { where: { kind: 'other' } });
  // @ts-expect-error 条件字段 version 不接受字符串。
  await rows.findOne(ownerId, { where: { version: '2' } });
  // @ts-expect-error 更新字段 title 不接受数字。
  await rows.updateWhere(ownerId, { where: { id: 'id' }, set: { title: 42 } });
  // @ts-expect-error 更新必须有明确的 where。
  await rows.updateWhere(ownerId, { set: { title: '缺失条件' } });
  // @ts-expect-error 归属字段必须通过独立 ownerId 参数传入。
  await rows.updateWhere(ownerId, { where: { id: 'id' }, set: { ownerId } });
  // @ts-expect-error 插入仍要求 title 等必填业务字段。
  await rows.insert(ownerId, { kind: 'private' });
  // 未传事务时运行时拒绝行锁。
  await rows.findOne(ownerId, { where: { id: 'id' }, lock: 'update' });
  await rows.findOne(ownerId, { where: { id: 'id' }, lock: 'update' }, tx);
  // 未开放清理能力的表在运行时拒绝物理删除。
  await rows.deleteWhere(ownerId, { id: 'id' });
  const history = database.personaTemplateVersions;
  // 版本表在运行时拒绝改写历史。
  await history.updateWhere(ownerId, { where: { id: 'id' }, set: { name: '改写历史' } });
}
