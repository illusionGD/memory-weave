import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { createPool } from 'mysql2/promise';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { mysqlConnectionOptions } from '../../database/connection';
import type { SystemStatus } from '@memory-weave/contracts';
import { SERVER_CONFIG } from '../../config';
import type { RuntimeConfig } from '../../config';
import { DatabaseService } from '../../database/database.service';

const PACKAGE_INFO = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as { version: string };

/** 通过实际连接和文件写入检查依赖服务是否可用。 */
@Injectable()
export class SystemService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: RuntimeConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {
    this.pool = createPool({
      ...mysqlConnectionOptions(config.databaseUrl),
      connectionLimit: 2,
      maxIdle: 2,
      idleTimeout: 10_000,
      queueLimit: 8,
    });
  }

  /**
   * 为登录后的运行状态页面提供已脱敏的检查结果。
   * @returns 应用、MySQL、Qdrant 和可写存储目录的可用状态。
   */
  async getStatus(): Promise<SystemStatus> {
    const [database, storage, schema, vectorStore] = await Promise.all([
      this.probeDatabase(),
      this.probeStorage(),
      this.database.getSchemaStatus(),
      this.probeVectorStore(),
    ]);
    return {
      service: 'memory-weave',
      version: PACKAGE_INFO.version,
      stage: 'foundation',
      database,
      vectorStore,
      storage,
      schema,
    };
  }

  /** 应用关闭时释放全部 MySQL 连接。 */
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  private async probeDatabase(): Promise<SystemStatus['database']> {
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>({
        sql: 'SELECT VERSION() AS version',
        timeout: 1000,
      });
      const version: unknown = rows[0]?.version;
      if (typeof version !== 'string') throw new Error();
      return { engine: 'mysql', status: 'connected', version };
    } catch {
      return { engine: 'mysql', status: 'unavailable', version: null };
    }
  }

  private async probeVectorStore(): Promise<SystemStatus['vectorStore']> {
    try {
      const options: RequestInit = {
        headers: { 'api-key': this.config.qdrantApiKey },
        signal: AbortSignal.timeout(1500),
        redirect: 'error',
      };
      // /readyz 可匿名访问，集合接口额外确认访问密钥确实可用。
      const [ready, info, collections] = await Promise.all([
        fetch(`${this.config.qdrantUrl}/readyz`, options),
        fetch(`${this.config.qdrantUrl}/`, options),
        fetch(`${this.config.qdrantUrl}/collections`, options),
      ]);
      if (!ready.ok || !info.ok || !collections.ok) {
        await Promise.all([ready.body?.cancel(), info.body?.cancel(), collections.body?.cancel()]);
        throw new Error();
      }
      const value: unknown = await info.json();
      await Promise.all([ready.body?.cancel(), collections.body?.cancel()]);
      if (
        !value ||
        typeof value !== 'object' ||
        !('version' in value) ||
        typeof value.version !== 'string'
      )
        throw new Error();
      return { engine: 'qdrant', status: 'connected', version: value.version };
    } catch {
      return { engine: 'qdrant', status: 'unavailable', version: null };
    }
  }

  private async probeStorage(): Promise<SystemStatus['storage']> {
    const probePath = join(this.config.dataDir, `.health-${randomBytes(12).toString('hex')}`);
    try {
      await mkdir(this.config.dataDir, { recursive: true });
      await writeFile(probePath, 'ready', { flag: 'wx', mode: 0o600 });
      await rm(probePath);
      return { status: 'ready' };
    } catch {
      return { status: 'unavailable' };
    } finally {
      await rm(probePath, { force: true }).catch(() => undefined);
    }
  }
}
