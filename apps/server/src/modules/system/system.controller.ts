import { Controller, Get, Inject } from '@nestjs/common';
import type { SystemStatus } from '@memory-weave/contracts';
import { SystemService } from './system.service';

/** 需要登录才能访问的管理状态接口，由全局守卫校验会话。 */
@Controller('system')
export class SystemController {
  constructor(@Inject(SystemService) private readonly system: SystemService) {}

  /**
   * 展示依赖服务的实际状态，不返回环境变量的值。
   * @returns 已脱敏的运行状态。
   */
  @Get('status')
  getStatus(): Promise<SystemStatus> {
    return this.system.getStatus();
  }
}
