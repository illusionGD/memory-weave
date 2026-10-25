/** 对外请求错误；只向界面暴露可处理的状态，不展示服务端原始响应。 */
export class ApiError extends Error {
  /** HTTP 状态；连接失败或超时没有 HTTP 状态。 */
  readonly status: number | null;

  /**
   * 创建可供页面区分认证失败和服务不可用的错误。
   * @param message 适合展示给使用者的错误说明。
   * @param status HTTP 响应状态，连接失败时为 null。
   */
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface ResponseSchema<T> {
  /** 在类型进入页面前检查服务端响应。 */
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

const REQUEST_TIMEOUT_MS = 15_000;

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
      if (response.status === 401) {
        throw new ApiError('请登录后继续。', response.status);
      }

      if (response.status === 429) {
        throw new ApiError('尝试次数过多，请稍后再试。', response.status);
      }

      throw new ApiError('服务暂时不可用，请稍后重试。', response.status);
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
 * 发送不需要读取响应内容的操作，例如退出登录。
 * @param path 同源 API 路径。
 * @param options HTTP 请求参数。
 * @returns 服务端已成功响应的结果。
 */
export function request(path: string, options: RequestInit = {}): Promise<Response> {
  return executeRequest(path, options, async (response) => response);
}

/**
 * 读取 JSON 并使用共享契约检查，防止失配响应被当作正常业务数据。
 * @param path 同源 API 路径。
 * @param schema 对应 API 的公共响应契约。
 * @param options HTTP 请求参数。
 * @returns 通过契约验证的响应。
 */
export async function requestJson<T>(
  path: string,
  schema: ResponseSchema<T>,
  options: RequestInit = {},
): Promise<T> {
  return executeRequest(path, options, async (response) => {
    let value: unknown;

    try {
      value = await response.json();
    } catch {
      throw new ApiError('服务返回了无法识别的内容，请重试。', response.status);
    }

    const parsed = schema.safeParse(value);

    if (!parsed.success) {
      throw new ApiError('服务响应与当前页面不匹配，请刷新页面后重试。', response.status);
    }

    return parsed.data;
  });
}
