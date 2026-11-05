import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import { ApiException } from '../http/api-exception';

/** 当前请求或任务的身份；每条执行链独立保存，不写入数据库单例。 */
export interface ExecutionIdentity {
  ownerId: string | null;
}

/** 在请求和后台任务之间隔离数据归属。 */
@Injectable()
export class IdentityContext {
  private readonly storage = new AsyncLocalStorage<ExecutionIdentity>();

  /** 在框架入口建立独立上下文，业务服务直接读取身份。 */
  run<T>(ownerId: string | null, operation: () => T): T {
    return this.storage.run({ ownerId }, operation);
  }

  /** 将已验证的会话身份写入当前请求，不允许中途切换归属。 */
  authenticate(ownerId: string): void {
    const identity = this.storage.getStore();
    if (!identity || !ownerId || (identity.ownerId && identity.ownerId !== ownerId))
      throw new ApiException(API_CODES.AUTH_REQUIRED);
    identity.ownerId = ownerId;
  }

  /** 取得可信身份，未认证的调用不回退到默认用户。 */
  require(): ExecutionIdentity & { ownerId: string } {
    const identity = this.storage.getStore();
    if (!identity?.ownerId) throw new ApiException(API_CODES.AUTH_REQUIRED);
    return identity as ExecutionIdentity & { ownerId: string };
  }
}
