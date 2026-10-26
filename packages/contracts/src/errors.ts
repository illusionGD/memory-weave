import { z } from 'zod';

/** HTTP 请求追踪响应头；由服务端生成，与业务命令的幂等 requestId 相互独立。 */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** 业务错误码常量，仅包含稳定的协议值；调用方通过属性引用，避免散落字符串。 */
export const ApiErrorCode = {
  /** 请求字段、路径参数或查询参数不符合契约。 */
  INVALID_REQUEST: 'INVALID_REQUEST',
  /** 请求正文不能解析为 JSON，不回显正文。 */
  INVALID_JSON: 'INVALID_JSON',
  /** 外键、非空、检查约束或数据库字段格式不合法。 */
  DATA_CONSTRAINT_VIOLATION: 'DATA_CONSTRAINT_VIOLATION',
  /** 会话缺失、过期或已撤销，需要重新登录。 */
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  /** 登录凭据不正确，不应当作服务故障。 */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** 浏览器写请求的 Origin 不被当前部署允许。 */
  ORIGIN_NOT_ALLOWED: 'ORIGIN_NOT_ALLOWED',
  /** 通用访问拒绝；私有资源的不可见情况仍使用 RESOURCE_NOT_FOUND。 */
  ACCESS_DENIED: 'ACCESS_DENIED',
  /** 不存在和不可见共用同一错误，避免泄露其他私有资源的存在性。 */
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  /** 目标接口不支持当前 HTTP 方法。 */
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  /** 服务端接收请求超时；与客户端断网或本地超时不同。 */
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  /** 无法进一步分类的状态或唯一约束冲突。 */
  CONFLICT: 'CONFLICT',
  /** 同作用域的幂等键已被用于不同内容，不能直接重试。 */
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  /** 消息修订号或会话版本已变化，需要读取最新状态。 */
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  /** 实例已经进入新的运行代次，禁止自动替旧命令更换代次。 */
  RUNTIME_EPOCH_MISMATCH: 'RUNTIME_EPOCH_MISMATCH',
  /** 成员权限版本已变化，必须重新检查可见范围。 */
  PERMISSION_VERSION_CONFLICT: 'PERMISSION_VERSION_CONFLICT',
  /** 消息已由另一个发布命令发布，不能再次发布。 */
  MESSAGE_ALREADY_PUBLISHED: 'MESSAGE_ALREADY_PUBLISHED',
  /** 当前存储支持的序号或版本上限已达到。 */
  VERSION_LIMIT_REACHED: 'VERSION_LIMIT_REACHED',
  /** 当前发言者已经离开会话。 */
  MEMBER_LEFT: 'MEMBER_LEFT',
  /** 请求正文超出服务允许的体积。 */
  REQUEST_BODY_TOO_LARGE: 'REQUEST_BODY_TOO_LARGE',
  /** 请求使用了不受支持的正文编码或媒体类型。 */
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  /** 登录次数或当前接收能力达到限额。 */
  RATE_LIMITED: 'RATE_LIMITED',
  /** 未预期的内部错误；响应与日志不包含原始异常或堆栈。 */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** 上游服务未返回可用响应。 */
  BAD_GATEWAY: 'BAD_GATEWAY',
  /** 无法进一步分类的暂时不可用。 */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /** 数据库连接、结构或必要的数据记录尚未就绪。 */
  DATA_UNAVAILABLE: 'DATA_UNAVAILABLE',
  /** 健康检查发现数据库、结构或文件存储不可用。 */
  DEPENDENCIES_UNAVAILABLE: 'DEPENDENCIES_UNAVAILABLE',
  /** 等待上游服务响应超时。 */
  GATEWAY_TIMEOUT: 'GATEWAY_TIMEOUT',
} as const;

/** 当前版本已登记的错误码类型，从同名常量的值推导。 */
export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

/**
 * 各终端共用的业务错误目录。code 是稳定标识，statusCode 是 HTTP 状态，message 是安全的中文提示。
 * 使用 ApiErrorCode 关联状态和提示；客户端按 code 判断行为，不能匹配提示文字。
 */
export const API_ERRORS = {
  [ApiErrorCode.INVALID_REQUEST]: { statusCode: 400, message: '请求参数不符合接口约定。' },
  [ApiErrorCode.INVALID_JSON]: { statusCode: 400, message: '请求正文不是有效的 JSON。' },
  [ApiErrorCode.DATA_CONSTRAINT_VIOLATION]: {
    statusCode: 400,
    message: '关联数据或字段不符合约束。',
  },
  [ApiErrorCode.AUTH_REQUIRED]: { statusCode: 401, message: '请登录后继续。' },
  [ApiErrorCode.INVALID_CREDENTIALS]: { statusCode: 401, message: '密码不正确，请重试。' },
  [ApiErrorCode.ORIGIN_NOT_ALLOWED]: { statusCode: 403, message: '请求来源不被允许。' },
  [ApiErrorCode.ACCESS_DENIED]: { statusCode: 403, message: '没有执行此操作的权限。' },
  [ApiErrorCode.RESOURCE_NOT_FOUND]: { statusCode: 404, message: '资源不存在或不可访问。' },
  [ApiErrorCode.METHOD_NOT_ALLOWED]: { statusCode: 405, message: '接口不支持此请求方式。' },
  [ApiErrorCode.REQUEST_TIMEOUT]: { statusCode: 408, message: '请求超时，请稍后重试。' },
  [ApiErrorCode.CONFLICT]: { statusCode: 409, message: '操作与当前状态冲突，请刷新后核对。' },
  [ApiErrorCode.IDEMPOTENCY_CONFLICT]: {
    statusCode: 409,
    message: '请求标识已用于不同内容，请核对操作。',
  },
  [ApiErrorCode.VERSION_CONFLICT]: { statusCode: 409, message: '数据版本已变化，请刷新后核对。' },
  [ApiErrorCode.RUNTIME_EPOCH_MISMATCH]: {
    statusCode: 409,
    message: '伴侣运行代次已变化，请重新读取实例状态。',
  },
  [ApiErrorCode.PERMISSION_VERSION_CONFLICT]: {
    statusCode: 409,
    message: '成员权限已变化，请重新读取会话状态。',
  },
  [ApiErrorCode.MESSAGE_ALREADY_PUBLISHED]: {
    statusCode: 409,
    message: '消息已通过其他发布命令发布，请核对结果。',
  },
  [ApiErrorCode.VERSION_LIMIT_REACHED]: {
    statusCode: 409,
    message: '会话或消息版本已达到当前存储上限。',
  },
  [ApiErrorCode.MEMBER_LEFT]: { statusCode: 409, message: '发言者已离开会话。' },
  [ApiErrorCode.REQUEST_BODY_TOO_LARGE]: {
    statusCode: 413,
    message: '请求内容过大，请缩小后重试。',
  },
  [ApiErrorCode.UNSUPPORTED_MEDIA_TYPE]: {
    statusCode: 415,
    message: '请求内容格式或编码不受支持。',
  },
  [ApiErrorCode.RATE_LIMITED]: { statusCode: 429, message: '尝试次数过多，请稍后再试。' },
  [ApiErrorCode.INTERNAL_ERROR]: { statusCode: 500, message: '服务处理失败，请稍后重试。' },
  [ApiErrorCode.BAD_GATEWAY]: { statusCode: 502, message: '上游服务响应异常，请稍后重试。' },
  [ApiErrorCode.SERVICE_UNAVAILABLE]: { statusCode: 503, message: '服务暂时不可用，请稍后重试。' },
  [ApiErrorCode.DATA_UNAVAILABLE]: { statusCode: 503, message: '数据服务或数据库结构尚未就绪。' },
  [ApiErrorCode.DEPENDENCIES_UNAVAILABLE]: {
    statusCode: 503,
    message: '依赖服务或数据库结构尚未就绪。',
  },
  [ApiErrorCode.GATEWAY_TIMEOUT]: { statusCode: 504, message: '上游服务响应超时，请稍后重试。' },
} as const satisfies Record<ApiErrorCode, { statusCode: number; message: string }>;

/** 已登记错误的 HTTP 状态与安全提示。 */
export type ApiErrorDefinition = (typeof API_ERRORS)[ApiErrorCode];

/** 当前版本已知错误码的校验规则；跨版本响应使用下方可扩展的字符串字段。 */
export const apiErrorCodeSchema = z.enum(ApiErrorCode);

const apiErrorResponseShape = {
  /** 实际 HTTP 状态码，必须与响应状态一致，不能把业务失败包成 200。 */
  statusCode: z.number().int().min(400).max(599),
  /** 稳定业务错误码；允许未来版本增加值，旧终端按 HTTP 状态降级。 */
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
  /** 可安全展示的提示，不能包含请求原文、凭据、SQL 或异常堆栈。 */
  message: z.string().min(1).max(300),
  /** 本次 HTTP 请求的服务端 UUID，与 X-Request-Id 响应头一致，不是业务幂等键。 */
  requestId: z.uuid(),
};

/** 所有 API 失败共用的响应契约；保留对未来新增字段及错误码的读取兼容。 */
export const apiErrorResponseSchema: z.ZodObject<typeof apiErrorResponseShape> =
  z.object(apiErrorResponseShape);

/** 终端接收到的统一错误响应。 */
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

/**
 * 查询当前版本认识的错误，未知码不读取对象原型。
 * @param code 服务端返回的业务错误码。
 * @returns 已登记的安全提示与状态；未知时为 undefined。
 */
export function getApiErrorDefinition(code: string): ApiErrorDefinition | undefined {
  return Object.hasOwn(API_ERRORS, code) ? API_ERRORS[code as ApiErrorCode] : undefined;
}

/**
 * 将框架异常或旧服务响应降级为已知的通用错误，不猜测具体业务原因。
 * @param statusCode 实际 HTTP 状态码。
 * @returns 当前终端可识别的通用错误码；其他状态统一使用内部错误提示。
 */
export function defaultApiErrorCode(statusCode: number): ApiErrorCode {
  const codes: Partial<Record<number, ApiErrorCode>> = {
    400: ApiErrorCode.INVALID_REQUEST,
    401: ApiErrorCode.AUTH_REQUIRED,
    403: ApiErrorCode.ACCESS_DENIED,
    404: ApiErrorCode.RESOURCE_NOT_FOUND,
    405: ApiErrorCode.METHOD_NOT_ALLOWED,
    408: ApiErrorCode.REQUEST_TIMEOUT,
    409: ApiErrorCode.CONFLICT,
    413: ApiErrorCode.REQUEST_BODY_TOO_LARGE,
    415: ApiErrorCode.UNSUPPORTED_MEDIA_TYPE,
    429: ApiErrorCode.RATE_LIMITED,
    502: ApiErrorCode.BAD_GATEWAY,
    503: ApiErrorCode.SERVICE_UNAVAILABLE,
    504: ApiErrorCode.GATEWAY_TIMEOUT,
  };
  return codes[statusCode] ?? ApiErrorCode.INTERNAL_ERROR;
}
