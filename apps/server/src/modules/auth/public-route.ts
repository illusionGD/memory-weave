import { SetMetadata } from '@nestjs/common';
import type { CustomDecorator } from '@nestjs/common';

/** 全局认证守卫用于识别显式公开路由的元数据键。 */
export const PUBLIC_ROUTE = 'memory-weave:public-route';

/**
 * 将路由标记为无需登录即可访问。
 * @returns 设置公开路由元数据的 Nest 装饰器。
 */
export function PublicRoute(): CustomDecorator<string> {
  return SetMetadata(PUBLIC_ROUTE, true);
}
