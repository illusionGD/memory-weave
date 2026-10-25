import { Controller, Get, Inject } from '@nestjs/common';
import type { SystemStatus } from '@memory-weave/contracts';
import { SystemService } from './system.service.js';

/** Private administrative state; the global guard enforces ownership. */
@Controller('system')
export class SystemController {
  constructor(@Inject(SystemService) private readonly system: SystemService) {}

  /**
   * Shows real dependency state without returning environment values.
   * @returns Sanitized runtime status.
   */
  @Get('status')
  getStatus(): Promise<SystemStatus> {
    return this.system.getStatus();
  }
}
