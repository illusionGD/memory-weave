import { apiErrorResponseSchema } from '@memory-weave/contracts';
import type { ApiErrorCode } from '@memory-weave/contracts';
import type { Response } from 'supertest';
import { expect } from 'vitest';

/** 从公开 HTTP 响应验证业务错误类别、共享结构和追踪编号的一致性。 */
export function expectApiError(response: Response, status: number, code: ApiErrorCode): void {
  expect(response.status).toBe(status);
  const body = apiErrorResponseSchema.parse(response.body);
  expect(body.statusCode).toBe(status);
  expect(body.code).toBe(code);
  expect(body.requestId).toBe(response.headers['x-request-id']);
  expect(response.body).toEqual(body);
}
