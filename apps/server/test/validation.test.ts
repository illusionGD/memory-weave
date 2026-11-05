import { createLogger, createHttpLogger } from '../src/logging';
import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  idPaginationQuerySchema,
  updateWorkspaceRequestSchema,
  uuidSchema,
  API_CODES,
  chatEventsQuerySchema,
  chatEventCursorSchema,
  versionParamSchema,
  emptyCommandSchema,
} from '@memory-weave/contracts';
import type {
  IdPaginationQuery,
  UpdateWorkspaceRequest,
  ChatEventsQuery,
  EmptyCommand,
} from '@memory-weave/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiExceptionFilter } from '../src/http/api-exception';
import { ApiResponseInterceptor } from '../src/http/api-response.interceptor';
import { RequestHeader, ZodValidationPipe } from '../src/http/zod-validation.pipe';
import { expectApiError } from './support/http';

@Controller('validation')
class ValidationController {
  /** 返回经过管道转换的请求体和路径参数。 */
  @Post(':id')
  save(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(updateWorkspaceRequestSchema)) body: UpdateWorkspaceRequest,
  ) {
    return { id, ...body };
  }

  /** 返回经过管道转换的查询参数。 */
  @Get()
  list(@Query(new ZodValidationPipe(idPaginationQuerySchema)) query: IdPaginationQuery) {
    return query;
  }

  /** 返回版本路径参数和重连游标的转换结果。 */
  @Get('cursor/:version')
  cursor(
    @Param('version', new ZodValidationPipe(versionParamSchema)) version: number,
    @Query(new ZodValidationPipe(chatEventsQuerySchema)) query: ChatEventsQuery,
    @RequestHeader('Last-Event-ID', new ZodValidationPipe(chatEventCursorSchema.optional()))
    lastEventId: number | undefined,
  ) {
    return { version, cursor: lastEventId ?? query.afterSequence };
  }

  /** 返回无载荷控制命令的校验结果。 */
  @Post('control/empty')
  control(@Body(new ZodValidationPipe(emptyCommandSchema)) body: EmptyCommand) {
    return body;
  }
}

@Module({ controllers: [ValidationController] })
class ValidationModule {}

describe('HTTP 参数自动校验与转换', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await NestFactory.create(ValidationModule, { logger: false });
    app.use(createHttpLogger(createLogger({ level: 'silent', format: 'json' })));
    app.useGlobalFilters(new ApiExceptionFilter());
    app.useGlobalInterceptors(new ApiResponseInterceptor());
    await app.init();
  });
  afterAll(async () => app?.close());

  it('控制器取得已规范化的请求体、数字查询参数及默认值', async () => {
    const saved = await request(app.getHttpServer())
      .post('/validation/645f6a0b-6d30-4d47-8d06-2b924854dfb8')
      .send({ displayName: '  小林  ' })
      .expect(201);
    expect(saved.body.data).toEqual({
      id: '645f6a0b-6d30-4d47-8d06-2b924854dfb8',
      displayName: '小林',
    });
    const explicit = await request(app.getHttpServer()).get('/validation?limit=3').expect(200);
    expect(explicit.body.data).toEqual({ limit: 3 });
    const defaults = await request(app.getHttpServer()).get('/validation').expect(200);
    expect(defaults.body.data).toEqual({ limit: 20 });
  });

  it.each(['0', '101', '1.5', '1e2', 'secret-invalid-value'])(
    '非法分页参数 %s 返回公共错误',
    async (limit) => {
      const response = await request(app.getHttpServer()).get('/validation').query({ limit });
      expectApiError(response, 400, API_CODES.INVALID_REQUEST);
      expect(response.text).not.toContain('secret-invalid-value');
    },
  );

  it('重复查询参数和未声明字段不能绕过契约', async () => {
    for (const path of ['/validation?limit=1&limit=2', '/validation?secret=private-content']) {
      const response = await request(app.getHttpServer()).get(path);
      expectApiError(response, 400, API_CODES.INVALID_REQUEST);
      expect(response.text).not.toContain('private-content');
    }
  });

  it('非法路径、空名称、嵌套类型及额外字段在进入业务前被拒绝', async () => {
    const invalidPath = await request(app.getHttpServer())
      .post('/validation/not-a-uuid')
      .send({ displayName: '小林' });
    expectApiError(invalidPath, 400, API_CODES.INVALID_REQUEST);
    for (const body of [
      { displayName: '   ' },
      { displayName: { password: 'private-content' } },
      { displayName: '小林', password: 'private-content' },
    ]) {
      const response = await request(app.getHttpServer())
        .post('/validation/645f6a0b-6d30-4d47-8d06-2b924854dfb8')
        .send(body);
      expectApiError(response, 400, API_CODES.INVALID_REQUEST);
      expect(response.text).not.toContain('private-content');
    }
  });

  it('重连请求头优先于查询游标，缺省使用查询值或零', async () => {
    const header = await request(app.getHttpServer())
      .get('/validation/cursor/2?afterSequence=3')
      .set('Last-Event-ID', '7')
      .expect(200);
    expect(header.body.data).toEqual({ version: 2, cursor: 7 });
    const query = await request(app.getHttpServer())
      .get('/validation/cursor/2?afterSequence=3')
      .expect(200);
    expect(query.body.data).toEqual({ version: 2, cursor: 3 });
    const initial = await request(app.getHttpServer()).get('/validation/cursor/2').expect(200);
    expect(initial.body.data).toEqual({ version: 2, cursor: 0 });
  });

  it('非法版本和重连参数返回统一错误，合法请求头不跳过查询校验', async () => {
    for (const version of ['01', '0', '1e2', '2147483648']) {
      expectApiError(
        await request(app.getHttpServer()).get(`/validation/cursor/${version}`),
        400,
        API_CODES.INVALID_REQUEST,
      );
    }
    for (const header of ['-1', '1.5', 'private-content']) {
      const response = await request(app.getHttpServer())
        .get('/validation/cursor/1')
        .set('Last-Event-ID', header);
      expectApiError(response, 400, API_CODES.INVALID_REQUEST);
      expect(response.text).not.toContain('private-content');
    }
    expectApiError(
      await request(app.getHttpServer())
        .get('/validation/cursor/1?afterSequence=bad')
        .set('Last-Event-ID', '3'),
      400,
      API_CODES.INVALID_REQUEST,
    );
  });

  it('无载荷控制命令接受省略正文和空对象，拒绝额外字段', async () => {
    const absent = await request(app.getHttpServer()).post('/validation/control/empty').expect(201);
    expect(absent.body.data).toEqual({});
    const empty = await request(app.getHttpServer())
      .post('/validation/control/empty')
      .send({})
      .expect(201);
    expect(empty.body.data).toEqual({});
    const invalid = await request(app.getHttpServer())
      .post('/validation/control/empty')
      .send({ action: 'other' });
    expectApiError(invalid, 400, API_CODES.INVALID_REQUEST);
  });
});
