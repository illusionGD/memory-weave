import { z } from 'zod';

/** 单用户登录请求；密码策略由服务端启动配置单独约束。 */
export const loginRequestSchema = z.object({ password: z.string().min(1).max(256) }).strict();

/** 会话身份仅由服务端 Cookie 决定，不向浏览器返回会话密钥。 */
export const sessionResponseSchema = z.object({ authenticated: z.literal(true) });

/** 管理入口的可观察基础状态，不包含连接串、密码或用户内容。 */
export const systemStatusSchema = z.object({
  service: z.literal('memory-weave'),
  version: z.string(),
  stage: z.literal('foundation'),
  database: z.object({
    status: z.enum(['connected', 'unavailable']),
    vectorVersion: z.string().nullable(),
  }),
  storage: z.object({ status: z.enum(['ready', 'unavailable']) }),
});

/** 登录请求的公共类型。 */
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** 已登录会话的公共类型。 */
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/** 运行检查结果的公共类型。 */
export type SystemStatus = z.infer<typeof systemStatusSchema>;
