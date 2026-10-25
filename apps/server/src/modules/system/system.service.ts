import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { SystemStatus } from '@memory-weave/contracts';
import { SERVER_CONFIG } from '../../config.js';
import type { RuntimeConfig } from '../../config.js';

const PACKAGE_INFO = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as { version: string };

/** Probes backing services through actual connections and filesystem writes. */
@Injectable()
export class SystemService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(@Inject(SERVER_CONFIG) private readonly config: RuntimeConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 3,
      connectionTimeoutMillis: 1000,
      idleTimeoutMillis: 10_000,
      query_timeout: 1000,
    });
    // An idle connection can disappear while PostgreSQL restarts; the next probe reports availability.
    this.pool.on('error', () => undefined);
  }

  /**
   * Returns sanitized state suitable for the authenticated deployment screen.
   * @returns Service, PostgreSQL extension and writable storage availability.
   */
  async getStatus(): Promise<SystemStatus> {
    const [database, storage] = await Promise.all([this.probeDatabase(), this.probeStorage()]);
    return {
      service: 'memory-weave',
      version: PACKAGE_INFO.version,
      stage: 'foundation',
      database,
      storage,
    };
  }

  /** Closes all PostgreSQL clients when the application shuts down. */
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
      // Credentials, connection strings and driver exceptions stay off the wire.
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
