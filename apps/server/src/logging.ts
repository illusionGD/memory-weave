import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '@memory-weave/contracts';
import { pino } from 'pino';
import type { DestinationStream, LevelWithSilent, Logger, LoggerOptions } from 'pino';
import { pinoHttp } from 'pino-http';

/** 日志的级别与展示格式，统一由部署环境配置。 */
export interface LoggingConfig {
  /** 低于该级别的事件不输出；silent 关闭输出。 */
  level: LevelWithSilent;
  /** pretty 用于本地开发，json 用于 PM2 收集和检索。 */
  format: 'json' | 'pretty';
}

/** 创建统一的 Pino 日志实例，生产只向标准输出写入 JSON。 */
export function createLogger(
  config: LoggingConfig = { level: 'info', format: 'json' },
  destination?: DestinationStream,
): Logger {
  const options: LoggerOptions = {
    level: config.level,
    base: { service: 'memory-weave', pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: safeError },
    hooks: {
      /** 防止 Pino 在省略文案时自动把原始异常消息复制到 msg。 */
      logMethod(args, method) {
        const [fields, message] = args;
        if (
          message === undefined &&
          (fields instanceof Error ||
            (typeof fields === 'object' &&
              fields !== null &&
              'err' in fields &&
              fields.err instanceof Error))
        ) {
          method.call(this, fields, '发生异常，请查看错误类型和位置。');
          return;
        }
        method.apply(this, args);
      },
    },
    // HTTP 入口只选择必要字段；此处也保护业务误传的常见凭据字段。
    redact: {
      paths: [
        'password',
        'token',
        'apiKey',
        'secret',
        'authorization',
        'cookie',
        'databaseUrl',
        'redisUrl',
        'authSessionSecret',
        'adminPassword',
        'qdrantApiKey',
        'req.headers',
        'req.body',
        'req.query',
        'res.headers',
      ],
      censor: '[REDACTED]',
    },
    ...(config.format === 'pretty'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: Boolean(process.stdout.isTTY), translateTime: 'SYS:standard' },
          },
        }
      : {}),
  };
  return destination ? pino(options, destination) : pino(options);
}

/** 为每次 HTTP 请求记录关联编号、状态和耗时，包括进入控制器前的失败。 */
export function createHttpLogger(logger: Logger) {
  return pinoHttp<Request, Response>({
    logger,
    wrapSerializers: false,
    quietReqLogger: true,
    customAttributeKeys: { reqId: 'requestId' },
    serializers: {
      req: (request: Request) => ({ id: request.id, method: request.method }),
      res: (response: Response) => ({ statusCode: response.statusCode }),
      err: safeError,
    },
    /** 生成服务端请求编号，忽略客户端传入的同名头。 */
    genReqId(_request, response) {
      const id = randomUUID();
      response.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
    customLogLevel: (_request, response, error) => {
      if (error || response.statusCode >= 500) return 'error';
      if (response.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: (_request, response) =>
      response.statusCode >= 400 ? '请求未完成。' : '请求完成。',
    customErrorMessage: () => '请求失败。',
    customSuccessObject: (request, response, value) => ({
      ...requestFields(request, response),
      responseTime: value.responseTime,
    }),
    customErrorObject: (request, response, error, value) => ({
      ...requestFields(request, response),
      err: error,
      responseTime: value.responseTime,
    }),
  });
}

/** 选取路由模板与业务码，不记录原始 URL、查询值或请求正文。 */
function requestFields(request: Request, response: Response) {
  return {
    event: response.statusCode >= 400 ? 'http.request.failed' : 'http.request.completed',
    statusCode: response.statusCode,
    method: request.method,
    route: typeof request.route?.path === 'string' ? request.route.path : 'unmatched',
    code: response.locals.apiCode,
  };
}

/** 提取异常类型、受控错误码和堆栈位置，丢弃消息、SQL、参数和外部响应。 */
export function safeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { type: 'UnknownError' };
  const code = 'code' in error ? error.code : undefined;
  const frames = error.stack
    ?.split('\n')
    .slice(1)
    .flatMap((line) => {
      if (!/^\s+at /.test(line)) return [];
      const match = line.match(/([\w.-]+\.[cm]?[jt]sx?):(\d+):(\d+)\)?$/);
      return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
    })
    .slice(0, 12);
  return {
    type: error.constructor.name,
    ...(typeof code === 'number' ||
    (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code))
      ? { code }
      : {}),
    ...(frames?.length ? { frames } : {}),
    ...(error.cause && depth < 3 ? { cause: safeError(error.cause, depth + 1) } : {}),
  };
}
