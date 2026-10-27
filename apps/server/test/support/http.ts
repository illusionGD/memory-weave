import { apiErrorResponseSchema } from '@memory-weave/contracts';
import type { ApiErrorCode } from '@memory-weave/contracts';
import type { Response } from 'supertest';
import { expect } from 'vitest';

/** 从公开 HTTP 响应验证数字业务码、公共结构与独立追踪响应头。 */
export function expectApiError(response: Response, status: number, code: ApiErrorCode): void {
  expect(response.status).toBe(status);
  const body = apiErrorResponseSchema.parse(response.body);
  expect(body.code).toBe(code);
  expect(body.data).toBeNull();
  expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  expect(response.body).toEqual(body);
}

/** 验证调用方预期的业务数据和完整成功外层；实际 HTTP 状态由请求断言单独检查。 */
export function expectApiSuccess(response: Response, data: unknown): void {
  expect([200, 201]).toContain(response.status);
  expect(response.body).toEqual({
    code: response.status,
    data,
    message: response.status === 201 ? '创建成功。' : '操作成功。',
  });
}
