import { retrievalConfigurationSchema } from '@memory-weave/contracts';
import type { RetrievalConfiguration } from '@memory-weave/contracts';
import { memoryConfigurationSchema } from '@memory-weave/contracts';
import type { MemoryConfiguration } from '@memory-weave/contracts';
import { chatConfigurationSchema } from '@memory-weave/contracts';
import type { ChatConfiguration } from '@memory-weave/contracts';
import { resolve } from 'node:path';
import { loadModelDeployment } from './modules/models/model-deployment';
import type { ModelDeployment } from './modules/models/model-deployment';

/** 由部署环境提供的服务端配置。 */
export interface ServerConfig {
  /** 集中检索预算，向量不可用时仍保留直接读取。 */
  retrievalConfiguration?: RetrievalConfiguration;
  /** 服务监听地址；开发环境默认仅监听本机回环地址。 */
  host: string;
  /** HTTP 服务监听端口。 */
  port: number;
  /** MySQL 连接串，包含私有凭据，不通过状态接口返回。 */
  databaseUrl: string;
  /** Qdrant HTTP 入口，仅在后端使用。 */
  qdrantUrl: string;
  /** Qdrant 访问密钥，不向浏览器或日志输出。 */
  qdrantApiKey: string;
  /** 部署时设置的登录密码，不通过 HTTP 接口或日志输出。 */
  adminPassword: string;
  /** 允许发送状态变更请求的浏览器来源，包含协议、主机和端口。 */
  appOrigin: string;
  /** 是否仅允许通过 HTTPS 传输会话 Cookie。 */
  cookieSecure: boolean;
  /** 附件等文件的持久存储目录。 */
  dataDir: string;
  /** 前端构建产物目录；为 null 时不启用静态页面托管。 */
  webDistDir: string | null;
  /** 仅服务端持有的供应商、密钥与资源上限；省略时仅提供测试模型。 */
  modelDeployment?: ModelDeployment;
  /** 集中聊天参数；每轮固定快照，部署变更不重解释正在运行的轮次。 */
  chatConfiguration?: ChatConfiguration;
  /** 每个生命周期清理事务的最多记录数，默认 100。 */
  lifecycleBatchSize?: number;
  /** 集中记忆整理参数，每批固定快照。 */
  memoryConfiguration?: MemoryConfiguration;
}

/** 运行时各模块使用的配置，排除无需继续持有的明文登录密码。 */
export type RuntimeConfig = Omit<ServerConfig, 'adminPassword'>;

/** 已校验且不含登录密码的运行时配置所使用的依赖注入标识。 */
export const SERVER_CONFIG = Symbol('SERVER_CONFIG');

/** 配置错误仅指出有问题的字段，不暴露其中的敏感值。 */
export class ConfigurationError extends Error {}

/**
 * 读取启动配置，在监听端口前拒绝不安全或含义不明确的配置值。
 * @param environment 环境变量；其中的敏感信息仅在服务端进程内部使用。
 * @returns 经过校验的服务端配置。
 */
export function loadServerConfig(environment: NodeJS.ProcessEnv): ServerConfig {
  const adminPassword = environment.ADMIN_PASSWORD ?? '';
  if (adminPassword.length < 12 || adminPassword.length > 256) {
    throw new ConfigurationError('ADMIN_PASSWORD must contain 12 to 256 characters.');
  }

  const databaseUrl = environment.DATABASE_URL ?? '';
  try {
    const parsed = new URL(databaseUrl);
    if (
      parsed.protocol !== 'mysql:' ||
      !parsed.hostname ||
      parsed.pathname.length < 2 ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('Invalid database URL');
    }
  } catch {
    throw new ConfigurationError(
      'DATABASE_URL must be a valid MySQL connection URL with a database name.',
    );
  }

  let qdrantUrl: string;
  try {
    const parsed = new URL(environment.QDRANT_URL ?? 'http://127.0.0.1:6333');
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    )
      throw new Error();
    qdrantUrl = parsed.origin;
  } catch {
    throw new ConfigurationError(
      'QDRANT_URL must be an HTTP(S) origin without credentials or a path.',
    );
  }
  const qdrantApiKey = environment.QDRANT_API_KEY ?? '';
  if (!/^[\x21-\x7e]{12,256}$/.test(qdrantApiKey))
    throw new ConfigurationError('QDRANT_API_KEY must contain 12 to 256 visible ASCII characters.');

  let appOrigin: string;
  try {
    const parsed = new URL(environment.APP_ORIGIN ?? 'http://localhost:5173');
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/'
    ) {
      throw new Error('Invalid origin');
    }
    appOrigin = parsed.origin;
  } catch {
    throw new ConfigurationError(
      'APP_ORIGIN must be an HTTP(S) origin without a path or credentials.',
    );
  }

  const port = Number(environment.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError('PORT must be an integer between 1 and 65535.');
  }

  const secureSetting = environment.COOKIE_SECURE;
  if (secureSetting !== undefined && !['true', 'false'].includes(secureSetting)) {
    throw new ConfigurationError('COOKIE_SECURE must be true or false.');
  }
  const cookieSecure =
    secureSetting === undefined ? appOrigin.startsWith('https://') : secureSetting === 'true';
  if (cookieSecure && !appOrigin.startsWith('https://')) {
    throw new ConfigurationError('COOKIE_SECURE=true requires an HTTPS APP_ORIGIN.');
  }
  if (!cookieSecure && appOrigin.startsWith('https://')) {
    throw new ConfigurationError('An HTTPS APP_ORIGIN requires COOKIE_SECURE=true.');
  }

  const host = environment.HOST?.trim() || '127.0.0.1';
  const dataDir = resolve(environment.DATA_DIR ?? './data');
  const webDistDir = environment.WEB_DIST_DIR ? resolve(environment.WEB_DIST_DIR) : null;
  let modelDeployment: ModelDeployment;
  try {
    modelDeployment = loadModelDeployment(environment);
  } catch {
    throw new ConfigurationError(
      '模型部署配置无效，请检查 MODEL_PROVIDERS_JSON、凭据引用和 MODEL_HARD_LIMITS_JSON。',
    );
  }

  const lifecycleBatchSize = Number(environment.LIFECYCLE_BATCH_SIZE || '100');
  if (!Number.isInteger(lifecycleBatchSize) || lifecycleBatchSize < 1 || lifecycleBatchSize > 500)
    throw new ConfigurationError('LIFECYCLE_BATCH_SIZE 必须为 1 到 500 的整数。');
  let chatConfiguration: ChatConfiguration;
  try {
    chatConfiguration = chatConfigurationSchema.parse(
      JSON.parse(environment.CHAT_CONFIG_JSON || '{}') as unknown,
    );
  } catch {
    throw new ConfigurationError('聊天配置无效，请检查 CHAT_CONFIG_JSON。');
  }

  let memoryConfiguration: MemoryConfiguration;
  try {
    memoryConfiguration = memoryConfigurationSchema.parse(
      JSON.parse(environment.MEMORY_CONFIG_JSON || '{}') as unknown,
    );
  } catch {
    throw new ConfigurationError('记忆配置无效，请检查 MEMORY_CONFIG_JSON。');
  }
  return {
    retrievalConfiguration: parseRetrievalConfiguration(environment.RETRIEVAL_CONFIG_JSON),
    memoryConfiguration,
    chatConfiguration,
    lifecycleBatchSize,
    host,
    port,
    databaseUrl,
    qdrantUrl,
    qdrantApiKey,
    adminPassword,
    appOrigin,
    cookieSecure,
    dataDir,
    webDistDir,
    modelDeployment,
  };
}

/** 配置错误仅指出字段，不回显配置内容。 */
function parseRetrievalConfiguration(value: string | undefined): RetrievalConfiguration {
  try {
    return retrievalConfigurationSchema.parse(JSON.parse(value || '{}') as unknown);
  } catch {
    throw new ConfigurationError('检索配置无效，请检查 RETRIEVAL_CONFIG_JSON。');
  }
}
