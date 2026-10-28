import { z } from 'zod';

export * from './common';
export * from './api';
export * from './companions';
export * from './conversations';
export * from './messages';

// 具名字段定义与 typeof 标注使 JSDoc 保留到生成的 .d.ts，供调用方查看提示。
const loginRequestShape = {
  /** 本次登录提交的部署密码，长度为 1～256；是否匹配由服务端验证，不在响应中返回。 */
  password: z.string().min(1).max(256),
};

/** 单用户登录请求；密码策略由服务端启动配置单独约束。 */
export const loginRequestSchema: z.ZodObject<typeof loginRequestShape, z.core.$strict> = z
  .object(loginRequestShape)
  .strict();

const sessionResponseShape = {
  /** 登录成功或当前会话有效时固定为 true；未登录或会话失效通过 HTTP 401 表达。 */
  authenticated: z.literal(true),
};

/** 会话身份仅由服务端 Cookie 决定，不向浏览器返回会话密钥。 */
export const sessionResponseSchema: z.ZodObject<typeof sessionResponseShape> =
  z.object(sessionResponseShape);

const databaseStatusShape = {
  /** connected 表示 MySQL 可执行查询；连接或查询失败时为 unavailable。 */
  status: z.enum(['connected', 'unavailable']),
  /** 实际 MySQL 服务版本；无法查询时为 null。 */
  version: z.string().nullable(),
  /** 主数据库引擎，与向量服务分开报告。 */
  engine: z.literal('mysql'),
};

const databaseStatusSchema: z.ZodObject<typeof databaseStatusShape> = z.object(databaseStatusShape);

const vectorStoreStatusShape = {
  /** 独立向量服务的引擎。 */
  engine: z.literal('qdrant'),
  /** connected 表示服务已就绪且配置的密钥能访问集合接口。 */
  status: z.enum(['connected', 'unavailable']),
  /** 实际 Qdrant 版本；连接或认证失败时为 null。 */
  version: z.string().nullable(),
};

const vectorStoreStatusSchema: z.ZodObject<typeof vectorStoreStatusShape> =
  z.object(vectorStoreStatusShape);

const storageStatusShape = {
  /** ready 表示目录可创建且临时文件写入、删除成功；任一步骤失败时为 unavailable。 */
  status: z.enum(['ready', 'unavailable']),
};

const storageStatusSchema: z.ZodObject<typeof storageStatusShape> = z.object(storageStatusShape);

const schemaStatusShape = {
  /** ready 表示迁移历史与当前发布包一致；pending 表示待升级；不可查询或历史不兼容时为 unavailable。 */
  status: z.enum(['ready', 'pending', 'unavailable']),
  /** 已应用的最新迁移名称；尚未迁移或无法确认时为 null。 */
  version: z.string().nullable(),
};

const schemaStatusSchema: z.ZodObject<typeof schemaStatusShape> = z.object(schemaStatusShape);

const systemStatusShape = {
  /** 服务标识，固定为 memory-weave，用于识别响应所属的应用。 */
  service: z.literal('memory-weave'),
  /** 后端应用的发布版本，取自服务端 package.json，例如 0.1.0。 */
  version: z.string(),
  /** 当前交付阶段；foundation 表示工程基础阶段，不代表服务是否健康。 */
  stage: z.literal('foundation'),
  /** 本次 MySQL 连接的实际探测结果。 */
  database: databaseStatusSchema,
  /** 独立 Qdrant 的连接与访问权限，不代表记忆索引已经建立。 */
  vectorStore: vectorStoreStatusSchema,
  /** 配置的持久文件目录的可用性探测结果，不向客户端暴露实际路径。 */
  storage: storageStatusSchema,
  /** 数据库结构与当前服务版本的兼容状态，连接成功不代表结构已就绪。 */
  schema: schemaStatusSchema,
};

/** 管理入口的可观察基础状态，不包含连接串、密码或用户内容。 */
export const systemStatusSchema: z.ZodObject<typeof systemStatusShape> =
  z.object(systemStatusShape);

/** 登录请求的公共类型。 */
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** 已登录会话的公共类型。 */
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/** 运行检查结果的公共类型。 */
export type SystemStatus = z.infer<typeof systemStatusSchema>;
export * from './models';
export * from './tasks';
export * from './persona-templates';
export * from './persona-document';
export * from './personas';
