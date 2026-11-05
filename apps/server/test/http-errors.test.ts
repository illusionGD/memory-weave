import express from 'express';
import { API_CODES } from '@memory-weave/contracts';
import { createOriginCheck, handleBodyError } from '../src/http-security';
import { createLogger, createHttpLogger } from '../src/logging';
import { DrizzleQueryError } from 'drizzle-orm';
import 'reflect-metadata';
import { Controller, Get, HttpException, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiException,
  ApiExceptionFilter,
  normalizeDatabaseError,
} from '../src/http/api-exception';
import { expectApiError } from './support/http';
import { ApiResponseInterceptor, ApiResult } from '../src/http/api-response.interceptor';

const PRIVATE_DIAGNOSTIC = 'private-password; SELECT private_text; mysql://private';

/** 只在测试 HTTP 服务内提供故障入口，不注册到生产应用或替换内部服务。 */
@Controller()
class FaultController {
  /** 返回带自定义业务码的测试成功响应。 */
  @Get('custom-success')
  customSuccess(): ApiResult<{ saved: boolean }> {
    return new ApiResult({ saved: true }, { code: 10000, message: '记录已保存。' });
  }

  /** 返回字段类似响应外层的测试业务数据。 */
  @Get('response-like-data')
  responseLikeData(): { code: number; data: string; message: string } {
    return { code: 42, data: '原始业务内容', message: '原始记录' };
  }

  /** 模拟数据库驱动异常，检查原因码与原始 SQL 的日志边界。 */
  @Get('database-error')
  databaseError(): never {
    const cause = Object.assign(new Error(PRIVATE_DIAGNOSTIC), { code: 'ER_ACCESS_DENIED_ERROR' });
    throw normalizeDatabaseError(
      new DrizzleQueryError('SELECT private_text', ['private-param'], cause),
    );
  }

  /** 返回固定内容，验证路径参数不会写入请求日志。 */
  @Get('items/:id')
  item(): { saved: boolean } {
    return { saved: true };
  }

  /** 抛出用于验证异常脱敏的测试错误。 */
  @Get('unknown-error')
  unknownError(): never {
    throw new Error(PRIVATE_DIAGNOSTIC);
  }

  /** 抛出用于验证异常兜底的非 Error 值。 */
  @Get('thrown-value')
  thrownValue(): never {
    throw { message: PRIVATE_DIAGNOSTIC, status: 401, code: 401 };
  }

  /** 抛出用于验证 HTTP 异常映射的测试错误。 */
  @Get('framework-error')
  frameworkError(): never {
    throw new HttpException({ message: PRIVATE_DIAGNOSTIC, code: 401 }, 400);
  }

  /** 抛出使用自定义业务码的测试异常。 */
  @Get('custom-error')
  customError(): never {
    throw new ApiException(10001, '当前伴侣正在休息。', 409);
  }

  /** 抛出使用自定义提示信息的测试异常。 */
  @Get('custom-message')
  customMessage(): never {
    throw new ApiException(40101, '此入口的密码不正确，请重新输入。');
  }
}

@Module({ controllers: [FaultController] })
class FaultModule {}

describe('HTTP 公共响应出口', () => {
  let app: INestApplication;
  let logs: Record<string, unknown>[];

  beforeEach(async () => {
    logs = [];
    app = await NestFactory.create(FaultModule, { logger: false, bodyParser: false });
    app.use(
      createHttpLogger(
        createLogger(
          { level: 'info', format: 'json' },
          {
            write(line) {
              logs.push(JSON.parse(line));
            },
          },
        ),
      ),
    );
    app.use(createOriginCheck(['http://localhost:5173']));
    app.use(express.json());
    app.use(handleBodyError);
    app.useGlobalFilters(new ApiExceptionFilter());
    app.useGlobalInterceptors(new ApiResponseInterceptor());
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('成功请求只记录一次，使用路由模板并排除凭据、查询和路径参数', async () => {
    const response = await request(app.getHttpServer())
      .get('/items/private-id?token=private-token')
      .set('Authorization', 'Bearer private-secret')
      .set('Cookie', 'private-cookie')
      .expect(200);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: 'http.request.completed',
      level: 30,
      method: 'GET',
      route: '/items/:id',
      requestId: response.headers['x-request-id'],
      responseTime: expect.any(Number),
    });
    expect(JSON.stringify(logs)).not.toContain('private');
  });

  it('数据库异常保留脱敏的驱动原因码，正文和日志不包含原始 SQL', async () => {
    const response = await request(app.getHttpServer()).get('/database-error').expect(503);
    expect(logs[0]).toMatchObject({
      err: {
        type: 'ApiException',
        code: 50301,
        cause: { type: 'DrizzleQueryError', cause: { code: 'ER_ACCESS_DENIED_ERROR' } },
      },
    });
    expect(JSON.stringify({ logs, body: response.body })).not.toContain('private');
  });

  it('控制器之前的来源拒绝与 JSON 解析失败也各记录一次', async () => {
    const denied = await request(app.getHttpServer())
      .post('/api/anything')
      .set('Origin', 'http://private-origin.invalid')
      .send({ password: 'private-body' })
      .expect(403);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: 'http.request.failed',
      code: API_CODES.ORIGIN_NOT_ALLOWED,
      requestId: denied.headers['x-request-id'],
      route: 'unmatched',
    });
    logs.length = 0;
    await request(app.getHttpServer())
      .post('/api/anything')
      .set('Content-Type', 'application/json')
      .send('{"private-body":')
      .expect(400);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ code: API_CODES.INVALID_JSON, route: 'unmatched' });
    expect(JSON.stringify(logs)).not.toContain('private');
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
    ['database-error', 503, 50301],
    ['missing-private-path', 404, 404],
  ] as const)('%s 返回受控错误且响应与日志不泄露原始内容', async (path, status, code) => {
    const response = await request(app.getHttpServer())
      .get(`/${path}?password=private-query`)
      .set('Cookie', 'private-cookie')
      .set('X-Request-Id', 'd1303412-e216-4a3a-8ac6-45c05def8b57');
    expectApiError(response, status, code);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).not.toBe('d1303412-e216-4a3a-8ac6-45c05def8b57');
    const output = JSON.stringify({ body: response.body, logs });
    expect(output).not.toContain('private');
    expect(response.text).not.toContain('frames');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: 'http.request.failed',
      requestId: response.headers['x-request-id'],
      statusCode: status,
      code,
      level: status >= 500 ? 50 : 40,
      responseTime: expect.any(Number),
    });
    if (path === 'unknown-error')
      expect(logs[0]).toMatchObject({ err: { type: 'Error', frames: expect.any(Array) } });
  });
});
