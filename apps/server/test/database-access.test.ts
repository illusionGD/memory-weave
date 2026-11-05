import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config';
import { DatabaseService } from '../src/database/database.service';
import { conversations } from '../src/database/schema';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';

describe('统一数据库表入口连接真实 MySQL', () => {
  let fixture: TestDatabase;
  let database: DatabaseService;
  let config: RuntimeConfig;

  beforeAll(async () => {
    fixture = await createTestDatabase();
    config = {
      databaseUrl: fixture.databaseUrl,
      host: '127.0.0.1',
      port: 0,
      redisUrl: 'redis://127.0.0.1:1',
      redisNamespace: 'unused',
      qdrantUrl: 'http://127.0.0.1:1',
      qdrantApiKey: 'unused',
      appOrigin: 'http://localhost',
      cookieSecure: false,
      dataDir: '/tmp',
      webDistDir: null,
    };
    database = new DatabaseService(config);
  });

  afterAll(async () => {
    await database?.onApplicationShutdown();
    await fixture?.dispose();
  });

  it('通过 database.表 直接读写，自动使用持久归属并保留投影及错误分类', async () => {
    const id = randomUUID();
    const input = {
      id,
      title: '数据库入口',
      kind: 'private' as const,
      requestId: randomUUID(),
      fingerprint: 'direct',
    };
    await database.conversations.insert(input);
    expect(
      await database.conversations.findOne({
        where: { id },
        fields: { label: conversations.title },
      }),
    ).toEqual({ label: '数据库入口' });
    const owner = await database.owners.findOne();
    expect((await database.conversations.findOne({ where: { id } }))?.ownerId).toBe(owner?.id);
    await expect(database.conversations.insert(input)).rejects.toMatchObject({ code: 409 });
  });
  it('直接表入口在数据库结构未就绪时返回统一不可用错误', async () => {
    const pending = await createTestDatabase({ migrate: false });
    const pendingDatabase = new DatabaseService({ ...config, databaseUrl: pending.databaseUrl });
    try {
      await expect(pendingDatabase.owners.findOne()).rejects.toMatchObject({ code: 50301 });
    } finally {
      await pendingDatabase.onApplicationShutdown();
      await pending.dispose();
    }
  });

  it('事务入口与原始 SQL 使用同一连接，普通入口读不到未提交记录且失败后回滚', async () => {
    const id = randomUUID();
    await expect(
      database.transaction(
        async (tx) => {
          await tx.conversations.insert({
            id,
            title: '未提交',
            kind: 'private',
            requestId: randomUUID(),
            fingerprint: 'rollback',
          });
          await tx.sql
            .update(conversations)
            .set({ title: '事务内修改' })
            .where(eq(conversations.id, id));
          expect((await tx.conversations.findOne({ where: { id }, lock: 'update' }))?.title).toBe(
            '事务内修改',
          );
          expect(await database.conversations.findOne({ where: { id } })).toBeNull();
          throw new Error('回滚本次事务');
        },
        { isolationLevel: 'read committed' },
      ),
    ).rejects.toThrow('回滚本次事务');
    expect(await database.conversations.exists({ id })).toBe(false);
  });

  it('并发事务的提交和回滚相互独立，既有 withOwner 回调也提供相同表入口', async () => {
    const ids = [randomUUID(), randomUUID()];
    const results = await Promise.allSettled(
      ids.map((id, index) =>
        database.transaction(
          async (tx) => {
            await tx.conversations.insert({
              id,
              title: `独立事务 ${index}`,
              kind: 'private',
              requestId: randomUUID(),
              fingerprint: 'parallel',
            });
            // 用普通入口查询，给另一个事务交错执行的机会，同时检查连接未泄漏。
            expect(await database.conversations.exists({ id })).toBe(false);
            expect((await tx.conversations.findOne({ where: { id } }))?.title).toBe(
              `独立事务 ${index}`,
            );
            if (index === 0) throw new Error('仅回滚第一笔');
          },
          { isolationLevel: 'read committed' },
        ),
      ),
    );
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(await database.conversations.exists({ id: ids[0]! })).toBe(false);
    const saved = await database.withOwner((ownerId, db) => {
      expect(db.ownerId).toBe(ownerId);
      return db.conversations.findOne({ where: { id: ids[1]! } });
    });
    expect(saved?.title).toBe('独立事务 1');
  });
});
