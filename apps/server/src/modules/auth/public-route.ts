import { SetMetadata } from '@nestjs/common';
import type { CustomDecorator } from '@nestjs/common';

/** Explicit allowlist marker used by the global authentication guard. */
export const PUBLIC_ROUTE = 'memory-weave:public-route';

/**
 * Marks a route as callable before signing in.
 * @returns Nest metadata decorator.
 */
export function PublicRoute(): CustomDecorator<string> {
  return SetMetadata(PUBLIC_ROUTE, true);
}
