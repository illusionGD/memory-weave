import type { UpdateWorkspaceRequest, WorkspaceResponse } from '@memory-weave/contracts';
import { API_CODES } from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { owners } from '../../database/schema';
import { ApiException } from '../../http/api-exception';

/** 维护部署管理者资料，改名只影响显示名称，不重建用户身份。 */
@Injectable()
export class WorkspaceService {
  /** 初始化部署管理者资料服务。 */
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /**
   * 查询当前部署管理者的身份和显示名称。
   *
   * 读取当前部署的资料，不接受请求指定其他 owner。
   */
  async get(ownerId: string): Promise<WorkspaceResponse> {
    const owner = await this.database.owners.findOne(ownerId, {
      fields: { ownerId: owners.id, displayName: owners.displayName },
    });
    if (!owner) throw new ApiException(API_CODES.DATA_UNAVAILABLE);
    return owner;
  }

  /**
   * 保存当前管理者的显示名称。
   *
   * 仅更新当前部署的显示字段，重复提交相同名称不会改变任何关联标识。
   */
  async update(ownerId: string, input: UpdateWorkspaceRequest): Promise<WorkspaceResponse> {
    const result = await this.database.owners.update(ownerId, ownerId, {
      displayName: input.displayName,
    });
    if (result.affectedRows === 0) throw new ApiException(API_CODES.DATA_UNAVAILABLE);
    return { ownerId, displayName: input.displayName };
  }
}
