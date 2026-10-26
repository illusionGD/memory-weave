import { API_ERROR_CODES } from '@memory-weave/contracts';
import { Controller, Get, Inject } from '@nestjs/common';
import { PublicRoute } from '../auth/public-route';
import { SystemService } from './system.service';
import { ApiException } from '../../http/api-exception';

/** 公开健康检查仅返回可用状态，不泄露具体配置。 */
@Controller('health')
export class HealthController {
  constructor(@Inject(SystemService) private readonly system: SystemService) {}

  /**
   * 报告 HTTP 服务进程是否存活，不依赖数据库等外部服务的状态。
   * @returns 仅包含存活状态的响应。
   */
  @PublicRoute()
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * 仅当 PostgreSQL、pgvector、数据库结构和可写存储目录均可用时报告服务就绪。
   * @returns 仅包含就绪状态的响应。
   */
  @PublicRoute()
  @Get('ready')
  async ready(): Promise<{ status: 'ok' }> {
    const status = await this.system.getStatus();
    if (
      status.database.status !== 'connected' ||
      status.storage.status !== 'ready' ||
      status.schema.status !== 'ready'
    ) {
      throw new ApiException(API_ERROR_CODES.DEPENDENCIES_UNAVAILABLE);
    }
    return { status: 'ok' };
  }
}
