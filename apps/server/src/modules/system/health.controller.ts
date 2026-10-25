import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { PublicRoute } from '../auth/public-route.js';
import { SystemService } from './system.service.js';

/** Public health responses disclose availability without configuration details. */
@Controller('health')
export class HealthController {
  constructor(@Inject(SystemService) private readonly system: SystemService) {}

  /**
   * Reports that the HTTP process is alive, independently of backing services.
   * @returns Minimal liveness response.
   */
  @PublicRoute()
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Requires PostgreSQL, pgvector and writable data storage before reporting ready.
   * @returns Minimal readiness response.
   */
  @PublicRoute()
  @Get('ready')
  async ready(): Promise<{ status: 'ok' }> {
    const status = await this.system.getStatus();
    if (status.database.status !== 'connected' || status.storage.status !== 'ready') {
      throw new ServiceUnavailableException('Backing services are not ready.');
    }
    return { status: 'ok' };
  }
}
