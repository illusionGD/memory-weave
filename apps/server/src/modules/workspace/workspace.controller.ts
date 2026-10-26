import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { updateWorkspaceRequestSchema } from '@memory-weave/contracts';
import type { WorkspaceResponse } from '@memory-weave/contracts';
import { parseInput } from '../shared/http';
import { WorkspaceService } from './workspace.service';

/** 管理当前部署的个人资料，身份由已认证部署确定。 */
@Controller('workspace')
export class WorkspaceController {
  constructor(@Inject(WorkspaceService) private readonly workspace: WorkspaceService) {}

  /** 读取稳定身份和当前显示名称，不把显示名称用于身份认证。 */
  @Get()
  get(): Promise<WorkspaceResponse> {
    return this.workspace.get();
  }

  /** 修改显示名称，不允许调用方选择用户身份或改写其他资料。 */
  @Patch()
  update(@Body() body: unknown): Promise<WorkspaceResponse> {
    return this.workspace.update(parseInput(updateWorkspaceRequestSchema, body));
  }
}
