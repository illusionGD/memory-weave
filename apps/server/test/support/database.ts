import { randomUUID } from 'node:crypto';
import { createConnection } from 'mysql2/promise';
import { mysqlConnectionOptions } from '../../src/database/connection';
import { runMigrations } from '../../src/database/migrations';

/** 单个测试用例或测试组独占的数据库。 */
export interface TestDatabase {
  /** 随机创建的测试数据库连接地址，不写入测试输出。 */
  databaseUrl: string;
  /** 释放本工具创建的数据库，不影响其他数据库。 */
  dispose(): Promise<void>;
}

/**
 * 使用显式测试连接创建隔离数据库，业务场景仍通过公开接口构造。
 * @param options 是否在创建后应用项目迁移；迁移验收可设为 false。
 * @returns 隔离数据库及清理方法。
 */
export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  if (!process.env.TEST_DATABASE_URL) throw new Error('需要显式配置 TEST_DATABASE_URL。');
  const maintenanceUrl = new URL(process.env.TEST_DATABASE_URL);
  const name = `mw_f02_${randomUUID().replaceAll('-', '')}`;
  const connection = await createConnection(mysqlConnectionOptions(maintenanceUrl.toString()));
  try {
    await connection.query(
      `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`,
    );
  } finally {
    await connection.end();
  }
  const databaseUrl = new URL(maintenanceUrl);
  databaseUrl.pathname = `/${name}`;
  let disposed = false;
  const result: TestDatabase = {
    databaseUrl: databaseUrl.toString(),
    async dispose() {
      if (disposed) return;
      const cleanup = await createConnection(mysqlConnectionOptions(maintenanceUrl.toString()));
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS \`${name}\``);
        disposed = true;
      } finally {
        await cleanup.end();
      }
    },
  };
  try {
    if (options.migrate !== false) await runMigrations(result.databaseUrl);
    return result;
  } catch (error) {
    await result.dispose();
    throw error;
  }
}
