import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

/** 把当前单用户部署映射到持久身份；未来账号登录不依赖此适配器。 */
@Injectable()
export class DeploymentIdentity {
  /** 保存身份查询入口，不缓存跨请求的可变当前用户。 */
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** 在部署登录或后台调度入口取得默认管理者。 */
  ownerId(): Promise<string> {
    return this.database.resolveDeploymentOwner('local');
  }
}
