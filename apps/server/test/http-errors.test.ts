import 'reflect-metadata';
import { Controller, Get, HttpException, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiException, ApiExceptionFilter, assignRequestId } from '../src/http/api-exception';
import { expectApiError } from './support/http';
import { ApiResponseInterceptor, ApiResult } from '../src/http/api-response.interceptor';

const PRIVATE_DIAGNOSTIC = 'private-password; SELECT private_text; postgres://private';

/** 只在测试 HTTP 服务内提供故障入口，不注册到生产应用或替换内部服务。 */
@Controller()
class FaultController {
  @Get('custom-success')
  customSuccess(): ApiResult<{ saved: boolean }> {
    return new ApiResult({ saved: true }, { code: 10000, message: '记录已保存。' });
  }

  @Get('response-like-data')
  responseLikeData(): { code: number; data: string; message: string } {
    return { code: 42, data: '原始业务内容', message: '原始记录' };
  }

  @Get('unknown-error')
  unknownError(): never {
    throw new Error(PRIVATE_DIAGNOSTIC);
  }

  @Get('thrown-value')
  thrownValue(): never {
    throw { message: PRIVATE_DIAGNOSTIC, status: 401, code: 401 };
  }

  @Get('framework-error')
  frameworkError(): never {
    throw new HttpException({ message: PRIVATE_DIAGNOSTIC, code: 401 }, 400);
  }

  @Get('custom-error')
  customError(): never {
    throw new ApiException(10001, '当前伴侣正在休息。', 409);
  }

  @Get('custom-message')
  customMessage(): never {
    throw new ApiException(40101, '此入口的密码不正确，请重新输入。');
  }
}

@Module({ controllers: [FaultController] })
class FaultModule {}

describe('HTTP 公共响应出口', () => {
  let app: INestApplication;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    app = await NestFactory.create(FaultModule, { logger: false });
    app.use(assignRequestId);
    app.useGlobalFilters(new ApiExceptionFilter());
    app.useGlobalInterceptors(new ApiResponseInterceptor());
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
  });

  it('成功响应支持自定义数字码和文案，仍保留单层公共外壳', async () => {
    const response = await request(app.getHttpServer()).get('/custom-success').expect(200);
    expect(response.body).toEqual({ code: 10000, data: { saved: true }, message: '记录已保存。' });
  });

  it('业务对象的同名字段保留在 data 内，不被误认为已经包装的响应', async () => {
    const response = await request(app.getHttpServer()).get('/response-like-data').expect(200);
    expect(response.body).toEqual({
      code: 200,
      data: { code: 42, data: '原始业务内容', message: '原始记录' },
      message: '操作成功。',
    });
  });

  it.each([
    ['custom-error', 409, 10001, '当前伴侣正在休息。'],
    ['custom-message', 401, 40101, '此入口的密码不正确，请重新输入。'],
  ] as const)('%s 保留业务明确提供的数字码和提示', async (path, status, code, message) => {
    const response = await request(app.getHttpServer()).get(`/${path}`).expect(status);
    expect(response.body).toEqual({ code, data: null, message });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    ['unknown-error', 500, 500],
    ['thrown-value', 500, 500],
    ['framework-error', 400, 400],
    ['missing-private-path', 404, 404],
  ] as const)('%s 返回受控错误且响应与日志不泄露原始内容', async (path, status, code) => {
    const response = await request(app.getHttpServer())
      .get(`/${path}?password=private-query`)
      .set('Cookie', 'private-cookie')
      .set('X-Request-Id', 'd1303412-e216-4a3a-8ac6-45c05def8b57');
    expectApiError(response, status, code);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).not.toBe('d1303412-e216-4a3a-8ac6-45c05def8b57');
    const output = JSON.stringify({ body: response.body, logs: log.mock.calls });
    expect(output).not.toContain('private');
    expect(output).not.toContain('stack');
    expect(log.mock.calls).toContainEqual([
      JSON.stringify({
        event: 'http.request.failed',
        requestId: response.headers['x-request-id'],
        statusCode: status,
        code,
      }),
    ]);
  });
});
