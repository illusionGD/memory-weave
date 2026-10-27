import {
  API_RESPONSES,
  REQUEST_ID_HEADER,
  apiErrorResponseSchema,
  apiResponseSchema,
  defaultApiErrorCode,
  uuidSchema,
} from '@memory-weave/contracts';
import type { ApiResponse } from '@memory-weave/contracts';

/** 对外请求错误；业务错误码与提示复用共享契约，不展示未经验证的远端内容。 */
export class ApiError extends Error {
  /** HTTP 状态；连接失败或超时没有 HTTP 状态。 */
  readonly status: number | null;
  /** 服务端的数字响应码；网络失败或不符合契约的响应为 null。 */
  readonly code: number | null;
  /** 服务端 HTTP 请求追踪编号；未收到有效编号时为 null，不是幂等键。 */
  readonly requestId: string | null;

  /**
   * 创建可供页面区分认证失败和服务不可用的错误。
   * @param message 适合展示给使用者的错误说明。
   * @param status HTTP 响应状态，连接失败时为 null。
   * @param code 经过契约验证的数字码，可包含未来版本增加的业务码。
   * @param requestId 经过 UUID 校验的服务端追踪编号。
   */
  constructor(
    message: string,
    status: number | null = null,
    code: number | null = null,
    requestId: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

interface ResponseSchema<T> {
  /** 在类型进入页面前检查服务端响应。 */
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * 校验统一错误并保留业务提示；旧格式或代理 HTML 按实际 HTTP 状态提供默认提示。
 * @param response 已收到的失败响应，正文读取仍受整次请求的超时限制。
 * @returns 含安全提示、原始状态、可用业务码和追踪编号的错误。
 */
async function readApiError(response: Response): Promise<ApiError> {
  const headerId = uuidSchema.safeParse(response.headers.get(REQUEST_ID_HEADER));
  const requestId = headerId.success ? headerId.data : null;
  const fallback = API_RESPONSES[defaultApiErrorCode(response.status)];
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return new ApiError(fallback.message, response.status, null, requestId);
  }
  const parsed = apiErrorResponseSchema.safeParse(value);
  if (parsed.success) {
    const body = parsed.data;
    return new ApiError(body.message, response.status, body.code, requestId);
  }
  return new ApiError(fallback.message, response.status, null, requestId);
}

/**
 * 校验成功响应的公共外层，允许业务自定义数字码和提示。
 * @param response 已收到的成功响应，正文读取仍受整次请求超时控制。
 * @returns 经过公共协议校验、尚未校验领域数据的响应。
 */
async function readApiResponse(response: Response): Promise<ApiResponse> {
  const headerId = uuidSchema.safeParse(response.headers.get(REQUEST_ID_HEADER));
  const requestId = headerId.success ? headerId.data : null;
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ApiError('服务返回了无法识别的内容，请重试。', response.status, null, requestId);
  }
  const parsed = apiResponseSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ApiError(
    '服务响应与当前页面不匹配，请刷新页面后重试。',
    response.status,
    null,
    requestId,
  );
}

/**
 * 请求与响应读取共用时限，避免服务仅发出响应头后页面永久等待。
 * @param path 同源 API 路径。
 * @param options HTTP 请求参数。
 * @param readResponse 仍受超时控制的响应读取过程。
 * @returns 经过读取的响应结果。
 */
async function executeRequest<T>(
  path: string,
  options: RequestInit,
  readResponse: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(path, {
      ...options,
      headers: { Accept: 'application/json', ...options.headers },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw await readApiError(response);
    }

    return await readResponse(response);
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      throw new ApiError('连接超时，请检查服务后重试。');
    }

    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError('无法连接服务，请检查网络后重试。');
  } finally {
    window.clearTimeout(timeout);
  }
}

/**
 * 发送不需要业务数据的操作，例如退出登录；仍须校验统一响应体。
 * @param path 同源 API 路径。
 * @param options HTTP 请求参数。
 * @returns 服务端已成功响应的结果。
 */
export function request(path: string, options: RequestInit = {}): Promise<void> {
  return executeRequest(path, options, async (response) => {
    await readApiResponse(response);
  });
}

/**
 * 读取 JSON 并使用共享契约检查，防止失配响应被当作正常业务数据。
 * @param path 同源 API 路径。
 * @param schema 对应 API 的 data 字段契约。
 * @param options HTTP 请求参数。
 * @returns 解开公共外层并通过领域契约校验的业务数据。
 */
export async function requestJson<T>(
  path: string,
  schema: ResponseSchema<T>,
  options: RequestInit = {},
): Promise<T> {
  return executeRequest(path, options, async (response) => {
    const body = await readApiResponse(response);
    const parsed = schema.safeParse(body.data);

    if (!parsed.success) {
      throw new ApiError('服务响应与当前页面不匹配，请刷新页面后重试。', response.status);
    }

    return parsed.data;
  });
}
