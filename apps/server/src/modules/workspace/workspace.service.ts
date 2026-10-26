import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { UpdateWorkspaceRequest, WorkspaceResponse } from '@memory-weave/contracts';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { owners } from '../../database/schema';

/** 维护部署管理者资料，改名只影响显示名称，不重建用户身份。 */
@Injectable()
export class WorkspaceService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** 读取当前部署的资料，不接受请求指定其他 owner。 */
  get(): Promise<WorkspaceResponse> {
    return this.database.withOwner(async (ownerId, db) => {
      const [owner] = await db
        .select({ ownerId: owners.id, displayName: owners.displayName })
        .from(owners)
        .where(eq(owners.id, ownerId))
        .limit(1);
      if (!owner) throw new ServiceUnavailableException('用户资料尚未就绪。');
      return { ...owner, schemaVersion: 1 };
    });
  }

  /** 仅更新当前部署的显示字段，重复提交相同名称不会改变任何关联标识。 */
  update(input: UpdateWorkspaceRequest): Promise<WorkspaceResponse> {
    return this.database.withOwner(async (ownerId, db) => {
      const [owner] = await db
        .update(owners)
        .set({ displayName: input.displayName })
        .where(eq(owners.id, ownerId))
        .returning({ ownerId: owners.id, displayName: owners.displayName });
      if (!owner) throw new ServiceUnavailableException('用户资料尚未就绪。');
      return { ...owner, schemaVersion: 1 };
    });
  }
}
