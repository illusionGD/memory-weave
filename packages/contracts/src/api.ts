import { z } from 'zod';

/** HTTP 请求追踪响应头；由服务端生成，与业务命令的幂等 requestId 相互独立。 */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** 各终端共用的常用数字响应码；通用码沿用 HTTP 数值，已登记业务码使用五位数字。 */
export const API_CODES = {
  /** 查询、更新、登录及无业务数据的操作成功。 */
  OK: 200,
  /** 创建、发布及接收成功，含幂等重放。 */
  CREATED: 201,
  /** 请求字段、路径参数或查询参数不符合契约。 */
  INVALID_REQUEST: 400,
  /** 请求正文不能解析为 JSON，不回显正文。 */
  INVALID_JSON: 40001,
  /** 外键、非空、检查约束或数据库字段格式不合法。 */
  DATA_CONSTRAINT_VIOLATION: 40002,
  /** 会话缺失、过期或已撤销，需要重新登录。 */
  AUTH_REQUIRED: 401,
  /** 登录凭据不正确，不应当作服务故障。 */
  INVALID_CREDENTIALS: 40101,
  /** 浏览器写请求的 Origin 不被当前部署允许。 */
  ORIGIN_NOT_ALLOWED: 40301,
  /** 通用访问拒绝；私有资源的不可见情况仍使用 RESOURCE_NOT_FOUND。 */
  ACCESS_DENIED: 403,
  /** 不存在和不可见共用同一错误，避免泄露其他私有资源的存在性。 */
  RESOURCE_NOT_FOUND: 404,
  /** 目标接口不支持当前 HTTP 方法。 */
  METHOD_NOT_ALLOWED: 405,
  /** 服务端接收请求超时；与客户端断网或本地超时不同。 */
  REQUEST_TIMEOUT: 408,
  /** 无法进一步分类的状态或唯一约束冲突。 */
  CONFLICT: 409,
  /** 同作用域的幂等键已被用于不同内容，不能直接重试。 */
  IDEMPOTENCY_CONFLICT: 40901,
  /** 消息修订号或会话版本已变化，需要读取最新状态。 */
  VERSION_CONFLICT: 40902,
  /** 实例已经进入新的运行代次，禁止自动替旧命令更换代次。 */
  RUNTIME_EPOCH_MISMATCH: 40903,
  /** 成员权限版本已变化，必须重新检查可见范围。 */
  PERMISSION_VERSION_CONFLICT: 40904,
  /** 消息已由另一个发布命令发布，不能再次发布。 */
  MESSAGE_ALREADY_PUBLISHED: 40905,
  /** 当前存储支持的序号或版本上限已达到。 */
  VERSION_LIMIT_REACHED: 40906,
  /** 当前发言者已经离开会话。 */
  MEMBER_LEFT: 40907,
  /** 请求正文超出服务允许的体积。 */
  REQUEST_BODY_TOO_LARGE: 413,
  /** 请求使用了不受支持的正文编码或媒体类型。 */
  UNSUPPORTED_MEDIA_TYPE: 415,
  /** 登录次数或当前接收能力达到限额。 */
  RATE_LIMITED: 429,
  /** 未预期的内部错误；响应与日志不包含原始异常或堆栈。 */
  INTERNAL_ERROR: 500,
  /** 上游服务未返回可用响应。 */
  BAD_GATEWAY: 502,
  /** 无法进一步分类的暂时不可用。 */
  SERVICE_UNAVAILABLE: 503,
  /** 数据库连接、结构或必要的数据记录尚未就绪。 */
  DATA_UNAVAILABLE: 50301,
  /** 健康检查发现数据库、结构或文件存储不可用。 */
  DEPENDENCIES_UNAVAILABLE: 50302,
  /** 等待上游服务响应超时。 */
  GATEWAY_TIMEOUT: 504,
} as const;

/** 当前版本已登记的响应码类型，从 API_CODES 常量的值推导。 */
export type ApiCode = (typeof API_CODES)[keyof typeof API_CODES];

/** 已登记失败码的联合类型，用于默认错误处理；自定义业务异常仍接受 number。 */
export type ApiErrorCode = Exclude<ApiCode, typeof API_CODES.OK | typeof API_CODES.CREATED>;

/**
 * 各终端共用的响应目录。数字 code、实际 HTTP 状态和安全中文提示在此统一维护。
 * 使用 API_CODES 关联状态和提示；客户端按 code 判断行为，不能匹配提示文字。
 */
export const API_RESPONSES = {
  [API_CODES.OK]: { statusCode: 200, message: '操作成功。' },
  [API_CODES.CREATED]: { statusCode: 201, message: '创建成功。' },
  [API_CODES.INVALID_REQUEST]: { statusCode: 400, message: '请求参数不符合接口约定。' },
  [API_CODES.INVALID_JSON]: { statusCode: 400, message: '请求正文不是有效的 JSON。' },
  [API_CODES.DATA_CONSTRAINT_VIOLATION]: {
    statusCode: 400,
    message: '关联数据或字段不符合约束。',
  },
  [API_CODES.AUTH_REQUIRED]: { statusCode: 401, message: '请登录后继续。' },
  [API_CODES.INVALID_CREDENTIALS]: { statusCode: 401, message: '密码不正确，请重试。' },
  [API_CODES.ORIGIN_NOT_ALLOWED]: { statusCode: 403, message: '请求来源不被允许。' },
  [API_CODES.ACCESS_DENIED]: { statusCode: 403, message: '没有执行此操作的权限。' },
  [API_CODES.RESOURCE_NOT_FOUND]: { statusCode: 404, message: '资源不存在或不可访问。' },
  [API_CODES.METHOD_NOT_ALLOWED]: { statusCode: 405, message: '接口不支持此请求方式。' },
  [API_CODES.REQUEST_TIMEOUT]: { statusCode: 408, message: '请求超时，请稍后重试。' },
  [API_CODES.CONFLICT]: { statusCode: 409, message: '操作与当前状态冲突，请刷新后核对。' },
  [API_CODES.IDEMPOTENCY_CONFLICT]: {
    statusCode: 409,
    message: '请求标识已用于不同内容，请核对操作。',
  },
  [API_CODES.VERSION_CONFLICT]: {
    statusCode: 409,
    message: '数据版本已变化，请刷新后核对。',
  },
  [API_CODES.RUNTIME_EPOCH_MISMATCH]: {
    statusCode: 409,
    message: '伴侣运行代次已变化，请重新读取实例状态。',
  },
  [API_CODES.PERMISSION_VERSION_CONFLICT]: {
    statusCode: 409,
    message: '成员权限已变化，请重新读取会话状态。',
  },
  [API_CODES.MESSAGE_ALREADY_PUBLISHED]: {
    statusCode: 409,
    message: '消息已通过其他发布命令发布，请核对结果。',
  },
  [API_CODES.VERSION_LIMIT_REACHED]: {
    statusCode: 409,
    message: '会话或消息版本已达到当前存储上限。',
  },
  [API_CODES.MEMBER_LEFT]: { statusCode: 409, message: '发言者已离开会话。' },
  [API_CODES.REQUEST_BODY_TOO_LARGE]: {
    statusCode: 413,
    message: '请求内容过大，请缩小后重试。',
  },
  [API_CODES.UNSUPPORTED_MEDIA_TYPE]: {
    statusCode: 415,
    message: '请求内容格式或编码不受支持。',
  },
  [API_CODES.RATE_LIMITED]: { statusCode: 429, message: '尝试次数过多，请稍后再试。' },
  [API_CODES.INTERNAL_ERROR]: { statusCode: 500, message: '服务处理失败，请稍后重试。' },
  [API_CODES.BAD_GATEWAY]: { statusCode: 502, message: '上游服务响应异常，请稍后重试。' },
  [API_CODES.SERVICE_UNAVAILABLE]: {
    statusCode: 503,
    message: '服务暂时不可用，请稍后重试。',
  },
  [API_CODES.DATA_UNAVAILABLE]: {
    statusCode: 503,
    message: '数据服务或数据库结构尚未就绪。',
  },
  [API_CODES.DEPENDENCIES_UNAVAILABLE]: {
    statusCode: 503,
    message: '依赖服务或数据库结构尚未就绪。',
  },
  [API_CODES.GATEWAY_TIMEOUT]: { statusCode: 504, message: '上游服务响应超时，请稍后重试。' },
} as const satisfies Record<ApiCode, { statusCode: number; message: string }>;

/** 已登记响应码的 HTTP 状态与安全提示。 */
export type ApiResponseDefinition = (typeof API_RESPONSES)[ApiCode];

/** 当前版本已知数字响应码的校验规则；跨版本响应使用下方可扩展的数字字段。 */
export const apiCodeSchema = z.enum(API_CODES);

const apiResponseShape = {
  /** 数字响应码，可引用 API_CODES，也可由业务自定义，无需预先登记。 */
  code: z.number(),
  /** 接口业务数据；无数据时必须为 null，不能省略该字段。 */
  data: z.unknown().refine((value) => value !== undefined),
  /** 业务明确提供的可展示提示；码表只提供默认文案，终端不能用文案判断业务行为。 */
  message: z.string(),
};

/** HTTP JSON 响应的公共外层；允许未来新增数字业务码，领域 schema 继续校验 data。 */
export const apiResponseSchema: z.ZodObject<typeof apiResponseShape> = z.object(apiResponseShape);

/** 各终端共用的泛型响应，T 对应具体接口的业务数据类型。 */
export type ApiResponse<T = unknown> = Omit<z.infer<typeof apiResponseSchema>, 'data'> & {
  /** 已通过领域 schema 校验的数据；无业务数据时使用 null。 */
  data: T;
};

const apiErrorResponseShape = {
  ...apiResponseShape,
  /** 失败时不返回部分业务结果、原始异常或堆栈，固定为 null。 */
  data: z.null(),
};

/** 错误也使用同一外层格式；请求追踪编号统一读取 X-Request-Id 响应头。 */
export const apiErrorResponseSchema: z.ZodObject<typeof apiErrorResponseShape> =
  z.object(apiErrorResponseShape);

/** 终端接收到的统一错误响应，数字 code 兼容未来新增的业务码。 */
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

/**
 * 查询当前版本认识的数字响应码，未知码不读取对象原型。
 * @param code 服务端返回的数字响应码。
 * @returns 已登记的安全提示与状态；未知时为 undefined。
 */
export function getApiResponseDefinition(code: number): ApiResponseDefinition | undefined {
  return Object.hasOwn(API_RESPONSES, code) ? API_RESPONSES[code as ApiCode] : undefined;
}

/**
 * 将框架异常或旧服务响应降级为已知的通用错误，不猜测具体业务原因。
 * @param statusCode 实际 HTTP 状态码。
 * @returns 当前终端可识别的通用错误码；其他状态统一使用内部错误提示。
 */
export function defaultApiErrorCode(statusCode: number): ApiErrorCode {
  const definition = getApiResponseDefinition(statusCode);
  return statusCode >= 400 && statusCode < 600 && definition?.statusCode === statusCode
    ? (statusCode as ApiErrorCode)
    : API_CODES.INTERNAL_ERROR;
}
