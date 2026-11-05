import { CurrentOwner } from '../auth/current-owner';
import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { updateWorkspaceRequestSchema } from '@memory-weave/contracts';
import type { UpdateWorkspaceRequest, WorkspaceResponse } from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { WorkspaceService } from './workspace.service';

/** 管理当前部署的个人资料，身份由已认证部署确定。 */
@Controller('workspace')
export class WorkspaceController {
  /** 初始化用户资料接口所需的服务。 */
  constructor(@Inject(WorkspaceService) private readonly workspace: WorkspaceService) {}

  /**
   * 查询当前部署管理者的资料。
   *
   * 读取稳定身份和当前显示名称，不把显示名称用于身份认证。
   */
  @Get()
  get(@CurrentOwner() ownerId: string): Promise<WorkspaceResponse> {
    return this.workspace.get(ownerId);
  }

  /**
   * 更新当前管理者的显示名称。
   *
   * 修改显示名称，不允许调用方选择用户身份或改写其他资料。
   */
  @Patch()
  update(
    @CurrentOwner() ownerId: string,
    @Body(new ZodValidationPipe(updateWorkspaceRequestSchema)) body: UpdateWorkspaceRequest,
  ): Promise<WorkspaceResponse> {
    return this.workspace.update(ownerId, body);
  }
}
