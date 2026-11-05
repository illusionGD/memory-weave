import { eq } from 'drizzle-orm';
import { createConnection } from 'mysql2/promise';
import { mysqlConnectionOptions } from '../src/database/connection';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config';
import { DatabaseService } from '../src/database/database.service';
import type { DatabaseTransaction } from '../src/database/database.service';
import { conversations } from '../src/database/schema';
import { createTestDatabase } from './support/database';
import type { TestDatabase } from './support/database';

describe('统一数据库表入口连接真实 MySQL', () => {
  let fixture: TestDatabase;
  let database: DatabaseService;
  let config: RuntimeConfig;
  let ownerId: string;

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
    ownerId = await database.resolveDeploymentOwner('local');
  });

  afterAll(async () => {
    await database?.onApplicationShutdown();
    await fixture?.dispose();
  });

  it('缺少可信身份时拒绝表操作，不回退到默认用户', async () => {
    await expect(database.conversations.findMany('', { limit: 20 })).rejects.toMatchObject({
      code: 401,
    });
  });

  it('并发用户共用表入口，但查询、更新和事务始终限定自己的归属', async () => {
    const otherOwner = randomUUID();
    const seed = await createConnection(mysqlConnectionOptions(fixture.databaseUrl));
    try {
      await seed.execute('INSERT INTO owners (id, deployment_key) VALUES (?, ?)', [
        otherOwner,
        otherOwner.slice(0, 32),
      ]);
    } finally {
      await seed.end();
    }
    const ids = [randomUUID(), randomUUID()];
    await Promise.all(
      [ownerId, otherOwner].map(async (owner, index) => {
        await database.transaction(async (tx) => {
          await database.conversations.insert(
            owner,
            {
              id: ids[index]!,
              title: `用户 ${index}`,
              kind: 'private',
              requestId: randomUUID(),
              fingerprint: 'isolated',
            },
            tx,
          );
        });
        expect(await database.conversations.findById(owner, ids[1 - index]!)).toBeNull();
        expect(
          (await database.conversations.update(owner, ids[1 - index]!, { title: '越界修改' }))
            .affectedRows,
        ).toBe(0);
        expect(
          await database.conversations.findOne(owner, {
            where: { id: ids[index]! },
            fields: ['title'],
          }),
        ).toEqual({ title: `用户 ${index}` });
      }),
    );
  });

  it('通过 database.表 显式传归属并保留投影及错误分类', async () => {
    const id = randomUUID();
    const input = {
      id,
      title: '数据库入口',
      kind: 'private' as const,
      requestId: randomUUID(),
      fingerprint: 'direct',
    };
    await database.conversations.insert(ownerId, input);
    expect(
      await database.conversations.findOne(ownerId, {
        where: { id },
        fields: { label: conversations.title },
      }),
    ).toEqual({ label: '数据库入口' });
    const owner = await database.owners.findOne(ownerId);
    expect((await database.conversations.findOne(ownerId, { where: { id } }))?.ownerId).toBe(
      owner?.id,
    );
    await expect(database.conversations.insert(ownerId, input)).rejects.toMatchObject({
      code: 409,
    });
  });
  it('直接表入口在数据库结构未就绪时返回统一不可用错误', async () => {
    const pending = await createTestDatabase({ migrate: false });
    const pendingDatabase = new DatabaseService({ ...config, databaseUrl: pending.databaseUrl });
    try {
      await expect(pendingDatabase.owners.findOne(ownerId)).rejects.toMatchObject({ code: 50301 });
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
          await database.conversations.insert(
            ownerId,
            {
              id,
              title: '未提交',
              kind: 'private',
              requestId: randomUUID(),
              fingerprint: 'rollback',
            },
            tx,
          );
          await tx
            .update(conversations)
            .set({ title: '事务内修改' })
            .where(eq(conversations.id, id));
          expect(
            (await database.conversations.findOne(ownerId, { where: { id }, lock: 'update' }, tx))
              ?.title,
          ).toBe('事务内修改');
          expect(await database.conversations.findOne(ownerId, { where: { id } })).toBeNull();
          throw new Error('回滚本次事务');
        },
        { isolationLevel: 'read committed' },
      ),
    ).rejects.toThrow('回滚本次事务');
    expect(await database.conversations.exists(ownerId, { id })).toBe(false);
  });

  it('事务结束后拒绝复用旧表入口，回滚后连接仍能承接后续事务', async () => {
    let expired: DatabaseTransaction | undefined;
    for (let i = 0; i < 6; i++) {
      await expect(
        database.transaction(async (tx) => {
          expired = tx;
          await database.owners.findOne(ownerId, undefined, tx);
          throw new Error('撤销');
        }),
      ).rejects.toThrow('撤销');
    }
    await expect(database.owners.findOne(ownerId, undefined, expired!)).rejects.toThrow(
      '事务已结束',
    );
    expect(await database.transaction((tx) => database.owners.exists(ownerId, undefined, tx))).toBe(
      true,
    );
  });

  it('并发事务的提交和回滚相互独立', async () => {
    const ids = [randomUUID(), randomUUID()];
    const results = await Promise.allSettled(
      ids.map((id, index) =>
        database.transaction(
          async (tx) => {
            await database.conversations.insert(
              ownerId,
              {
                id,
                title: `独立事务 ${index}`,
                kind: 'private',
                requestId: randomUUID(),
                fingerprint: 'parallel',
              },
              tx,
            );
            // 用普通入口查询，给另一个事务交错执行的机会，同时检查连接未泄漏。
            expect(await database.conversations.exists(ownerId, { id })).toBe(false);
            expect(
              (await database.conversations.findOne(ownerId, { where: { id } }, tx))?.title,
            ).toBe(`独立事务 ${index}`);
            if (index === 0) throw new Error('仅回滚第一笔');
          },
          { isolationLevel: 'read committed' },
        ),
      ),
    );
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(await database.conversations.exists(ownerId, { id: ids[0]! })).toBe(false);
    const saved = await database.conversations.findOne(ownerId, { where: { id: ids[1]! } });
    expect(saved?.title).toBe('独立事务 1');
  });
});
