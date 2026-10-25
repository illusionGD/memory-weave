---
name: foundation
description: >-
  维护 Memory Weave 的 F01 工程基础：workspace、登录与会话、运行检查、启动和部署。
  处理这些功能或诊断启动失败时使用，不将伴侣、记忆或持久任务归入本技能。
---

# F01 工程基础

先读 [功能说明](../../../docs/features/f01-foundation.md)、[启动文档](../../../README.md) 与相关 rules；当前实现范围和测试结果见 [进度](../../../docs/progress.md)。

## 代码入口

- `apps/server/src/main.ts` / `app.ts`：启动、配置及默认认证守卫。
- `apps/server/src/modules/auth`：单用户密码登录、服务端 Cookie 会话与撤销。
- `apps/server/src/modules/system`：真实 PostgreSQL、vector 和文件目录探测。
- `apps/web/src/services` / `stores` / `views`：同源 API、内存状态和中文界面。
- `packages/contracts`：公共 schema 和类型；更改接口时同步调用方。
- `deploy`、`Dockerfile`、`scripts`：数据库与应用启动、配置生成及生产打包。

## 保持的约束

- 用户使用 Node 22；最低 22.20.0，推荐版本见 `.nvmrc`。运行时、Node 类型、Docker 和 CI 保持一致；CI 验证最低版本与推荐版本。
- 公共契约字段使用中文 JSDoc，说明语义、枚举与空值含义；通过具名 shape 和 `z.ZodObject<typeof shape>` 保留声明文件的字段提示，类型继续从 schema 推导，不重复维护规则。
- 默认 API 需要认证，公开路由显式声明；前端路由判断不能代替后端控制。
- API 路径大小写与 Express 匹配保持一致；静态资源 fallback 不返回 API 的 HTML 页面。
- HTTP 入口不自动升级资源到 HTTPS；HTTPS 入口必须使用 Secure Cookie。
- 不记录密码、Cookie 或连接串，不把它们放入 Git、镜像构建上下文或浏览器存储。
- 会话目前位于进程内，12 小时过期、最多 10 个；服务重启后重登。后续业务持久化不得依赖该会话存储。
- 仅在配置的数据库真实可用、vector 存在、文件目录可写时报告就绪。
- 生产打包使用 workspace 注入、build 同步与锁文件；依赖变更后核对标准 `pnpm deploy` 和 Docker 构建。

## 验证与交付

沿用已确认的 Web、HTTP、配置和部署接口验证行为，不测试私有容器或内部调用顺序。按项目 TDD 指南小步验证；运行当前范围的格式、lint、typecheck、HTTP 测试、构建及必要 E2E。

真实数据库测试必须明确提供隔离的 `TEST_DATABASE_URL`；省略而跳过不能算通过。Docker SQL 初始化脚本需对容器用户可读，初始化失败时检查日志与实际扩展状态。

继续使用 `dev`，每个功能交付固定 SHA、比较基线、检查结果和启动步骤。用户已授权向 `illusionGD/memory-weave` 的 `dev` 推送当前文档及后续完成功能，无需为同一范围重复询问；不擅自改写已交付历史或推送其他分支。
