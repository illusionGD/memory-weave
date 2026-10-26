import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
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
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 3,
      connectionTimeoutMillis: 1000,
      idleTimeoutMillis: 10_000,
      query_timeout: 1000,
    });
    // PostgreSQL 重启可能导致空闲连接断开；由下一次探测确认当前可用状态。
    this.pool.on('error', () => undefined);
  }

  /**
   * 为登录后的运行状态页面提供已脱敏的检查结果。
   * @returns 应用、PostgreSQL 扩展和可写存储目录的可用状态。
   */
  async getStatus(): Promise<SystemStatus> {
    const [database, storage, schema] = await Promise.all([
      this.probeDatabase(),
      this.probeStorage(),
      this.database.getSchemaStatus(),
    ]);
    return {
      service: 'memory-weave',
      version: PACKAGE_INFO.version,
      stage: 'foundation',
      database,
      storage,
      schema,
    };
  }

  /** 应用关闭时释放全部 PostgreSQL 连接。 */
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  private async probeDatabase(): Promise<SystemStatus['database']> {
    try {
      const result = await this.pool.query<{ extversion: string }>(
        "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
      );
      const version = result.rows[0]?.extversion;
      if (!version) return { status: 'unavailable', vectorVersion: null };
      return { status: 'connected', vectorVersion: version };
    } catch {
      // 不向客户端返回凭据、连接串或数据库驱动的异常详情。
      return { status: 'unavailable', vectorVersion: null };
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
