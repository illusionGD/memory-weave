import { apiResponseSchema, getApiResponseDefinition } from '../packages/contracts/dist/index.js';

/** 只包含受控诊断，不把响应原文、Cookie、密码或地址带入输出。 */
export class ModelClientError extends Error {
  constructor(message, status = null, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 使用已配置的本部署入口登录，维护命令与验收脚本共用此 HTTP 边界。 */
export async function createModelClient() {
  let origin;
  try {
    const url = new URL(
      process.env.VERIFY_BASE_URL ?? process.env.APP_ORIGIN ?? 'http://localhost:5173',
    );
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    origin = url.origin;
  } catch {
    throw new ModelClientError('VERIFY_BASE_URL 或 APP_ORIGIN 必须是无凭据和路径的 HTTP(S) 入口。');
  }
  if (!process.env.ADMIN_PASSWORD)
    throw new ModelClientError('缺少 ADMIN_PASSWORD，请先完成部署配置。');
  let cookie;
  const api = async (path, options = {}) => {
    const { method = 'GET', body, timeoutMs = 30_000 } = options;
    let response;
    try {
      response = await fetch(`${origin}/api${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ModelClientError(
        '请求无法完成，请检查服务是否启动；已发出的诊断请用原 requestId 查询，勿直接重复创建。',
      );
    }
    let envelope;
    try {
      envelope = apiResponseSchema.parse(await response.json());
    } catch {
      throw new ModelClientError('接口未返回约定的 JSON，请检查后端与代理。', response.status);
    }
    if (!response.ok)
      throw new ModelClientError(
        getApiResponseDefinition(envelope.code)?.message ?? '接口未完成请求。',
        response.status,
        envelope.code,
      );
    if (path === '/auth/login') {
      cookie = response.headers
        .getSetCookie()
        .find((value) => value.startsWith('memory_weave_session='))
        ?.split(';')[0];
      if (!cookie) throw new ModelClientError('登录响应缺少会话。');
    }
    return envelope.data;
  };
  await api('/auth/login', { method: 'POST', body: { password: process.env.ADMIN_PASSWORD } });
  return api;
}

/** 失败只显示已知安全提示，不输出异常堆栈或环境配置。 */
export function reportModelClientError(error) {
  console.error(
    error instanceof ModelClientError
      ? error.message
      : '操作失败，请检查输入文件格式、权限及服务端运行状态。',
  );
  process.exitCode = 1;
}
