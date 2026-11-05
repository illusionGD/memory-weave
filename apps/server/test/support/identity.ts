import type { INestApplication } from '@nestjs/common';
import { IdentityContext } from '../../src/database/identity-context';
import { DeploymentIdentity } from '../../src/modules/auth/deployment-identity';

/** 为公开服务/worker 协议验收建立身份；HTTP 测试仍通过真实会话认证。 */
export async function asOwner<T>(app: INestApplication, operation: () => Promise<T>): Promise<T> {
  const ownerId = await app.get(DeploymentIdentity).ownerId();
  return app.get(IdentityContext).run(ownerId, operation);
}
