import type { INestApplication } from '@nestjs/common';
import { DeploymentIdentity } from '../../src/modules/auth/deployment-identity';

/** 为服务入口验收取得真实归属并显式传参；HTTP 测试仍使用会话认证。 */
export async function asOwner<T>(
  app: INestApplication,
  operation: (ownerId: string) => Promise<T>,
): Promise<T> {
  return operation(await app.get(DeploymentIdentity).ownerId());
}
