import 'reflect-metadata';
import { Controller, Get, HttpException, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiExceptionFilter } from '../src/http/api-exception.filter';
import { assignRequestId } from '../src/http/error-response';
import { expectApiError } from './support/http';

const PRIVATE_DIAGNOSTIC = 'private-password; SELECT private_text; postgres://private';

/** 只在测试 HTTP 服务内提供故障入口，不注册到生产应用或替换内部服务。 */
@Controller()
class FaultController {
  @Get('unknown-error')
  unknownError(): never {
    throw new Error(PRIVATE_DIAGNOSTIC);
  }

  @Get('thrown-value')
  thrownValue(): never {
    throw { message: PRIVATE_DIAGNOSTIC, status: 401, code: 'AUTH_REQUIRED' };
  }

  @Get('framework-error')
  frameworkError(): never {
    throw new HttpException({ message: PRIVATE_DIAGNOSTIC, code: 'AUTH_REQUIRED' }, 400);
  }
}

@Module({ controllers: [FaultController] })
class FaultModule {}

describe('HTTP 公共错误出口', () => {
  let app: INestApplication;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    app = await NestFactory.create(FaultModule, { logger: false });
    app.use(assignRequestId);
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
  });

  it.each([
    ['unknown-error', 500, 'INTERNAL_ERROR'],
    ['thrown-value', 500, 'INTERNAL_ERROR'],
    ['framework-error', 400, 'INVALID_REQUEST'],
    ['missing-private-path', 404, 'RESOURCE_NOT_FOUND'],
  ] as const)('%s 返回受控错误且响应与日志不泄露原始内容', async (path, status, code) => {
    const response = await request(app.getHttpServer())
      .get(`/${path}?password=private-query`)
      .set('Cookie', 'private-cookie')
      .set('X-Request-Id', 'd1303412-e216-4a3a-8ac6-45c05def8b57');
    expectApiError(response, status, code);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.requestId).not.toBe('d1303412-e216-4a3a-8ac6-45c05def8b57');
    const output = JSON.stringify({ body: response.body, logs: log.mock.calls });
    expect(output).not.toContain('private');
    expect(output).not.toContain('stack');
    expect(log.mock.calls).toContainEqual([
      JSON.stringify({
        event: 'http.request.failed',
        requestId: response.body.requestId,
        statusCode: status,
        code,
      }),
    ]);
  });
});
