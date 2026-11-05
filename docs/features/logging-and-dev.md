# Pino 日志与 Nest 开发启动

后端开发使用 `nest start --watch`，日志使用 Pino + nestjs-pino。接口、数据表和固定 12 小时登录有效期不变，无需迁移或重置数据。

## 本地更新

先停止原来的 dev 进程，再在项目根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm dev
```

根命令继续启动后端和两个 Vite 项目；`pnpm dev:web` / `pnpm dev:admin` 只启动后端与选定前端。环境与模型配置仍由根启动器加载。直接在 apps/server 执行 dev 时，需要自己提供这些环境变量。

Nest CLI 使用 Webpack 编译并监听后端与真实的 `packages/contracts/src`。它会解析源码中的无扩展名导入，把工作区代码打成 ESM，第三方依赖仍由 Node 加载；无需先构建共享包。修改、原子保存和新增被导入模块都会触发重新编译。编译失败时不会启动新构建，最后一次成功的进程可能继续服务；修正错误后自动重启。`browser-client` 仍由 Vite 处理，不会因此重启后端。

开发产物放在 `apps/server/.cache/nest`。正式构建仍使用 `pnpm build` 的 tsc + tsc-alias，输出到 `apps/server/dist`，PM2 运行 `dist/main.js`；不能将开发 bundle 拷贝到服务器。tsx 仅保留给维护命令与测试辅助脚本，不再负责后端 dev 启动。

## 日志配置

| 环境变量   | 默认                   | 用途                                                 |
| ---------- | ---------------------- | ---------------------------------------------------- |
| LOG_LEVEL  | info                   | trace / debug / info / warn / error / fatal / silent |
| LOG_FORMAT | 开发 pretty，其余 json | 开发易读输出或每行 JSON；正式只接受 json             |

修改后重启服务；已有 `.env` 不必补字段，省略即采用默认值。pino-pretty 是开发依赖，正式依赖包不需要它。

HTTP 每个请求只记录一条完成日志，包含服务、时间、级别、请求编号、方法、路由模板、状态和耗时。4xx 使用 warn，5xx 使用 error。来源校验失败、无效 JSON 和未知路由也会记录；这些请求可能尚未匹配路由，此时 route 为 unmatched。SSE 的完成日志在连接关闭时产生。

`X-Request-Id` 与日志中的 requestId 一致，由服务端生成，不采用客户端的同名头。路由只记录模板，如 `/api/chats/:id`；不记录实际路径参数、查询、请求头、Cookie、正文或响应数据。异常只保存类型、受控错误码与文件/行列位置，有限展开原因链；原始 message、SQL 和参数不会进入日志。

任务记录 taskId、类型、伴侣 ID 和尝试次数；心跳、派发及状态提交异常均有对应事件。`tasks.execution.finished` 是 debug 级别，表示本次执行结束，不等于任务成功；任务最终状态仍以数据库与管理接口为准。

## 业务用法

```ts
constructor(@Inject(PinoLogger) private readonly logger: PinoLogger) {}

this.logger.info({ event: 'tasks.execution.started', taskId }, '开始执行任务。');
this.logger.error({ event: 'tasks.execution.failed', taskId, err }, '任务执行失败。');
```

框架日志通过 Nest 的 Logger 接到同一套 Pino 配置。业务直接使用 PinoLogger；显式传稳定 ID，不能把配置对象、请求正文、模型输入输出或租约令牌放进日志。日志提供诊断，不替代持久任务和记忆历史。维护 CLI 的 JSON 结果与简短错误提示保留原输出协议。

## PM2 与滚动策略

完成配置、构建和必要的数据库初始化后：

```sh
pm2 start deploy/ecosystem.config.cjs
pm2 logs memory-weave --lines 100
```

配置使用单实例 fork，开启 Node source maps，并保持 Pino 的原始 JSON 行。文件由 PM2 写入自己的日志目录，可用 `pm2 describe memory-weave` 查看具体路径。应用本身不重复写一份文件。

在服务器上安装轮转模块并配置示例策略：

```sh
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
pm2 save
```

该示例按大小检查并每天轮转，保留 14 个归档文件，不等于固定保留 14 天；轮转检查有间隔，文件可能暂时超过阈值。每日时间按服务器时区解释。模块会管理该 PM2 实例的日志，已有其他应用时一起考虑容量和保留要求。本仓库提供配置和操作说明，不会自动连接用户服务器安装模块。

## Review 入口

- `apps/server/nest-cli.json`、`tsconfig.dev.json`、`webpack.config.cjs`：Nest CLI 的开发编译和监听。
- `apps/server/src/logging.ts`：格式、请求日志及异常脱敏。
- `apps/server/src/app.ts`、`http/api-exception.ts`：框架接入、统一响应和避免重复记录。
- `apps/server/src/modules/tasks/task-worker.service.ts`：后台任务事件。
- `deploy/ecosystem.config.cjs`：正式进程入口。

实际验证范围见 [开发进度](../progress.md)。
