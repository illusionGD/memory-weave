# F12 终端和动作回执

Web 用户登记设备并为具体工作区、会话和伴侣代次授予能力。设备随后凭专用凭据连接和上报实际实现的工具。聊天轮次保存当时有效的能力快照，动作领取时重新核对当前连接、工作区、来源、伴侣代次和授权版本。

首个工具为 `diagnostic.echo`。测试端只原样回传有界文本。它可用于验收跨终端调度，不赋予设备读写文件或执行系统命令的能力。用户经明确的 HTTP 动作命令发起诊断。聊天文本和模型输出只用于交流，本阶段的聊天模型没有直接派发设备动作的入口。

## 接口

- 登录后以设备 UUID 调用 `PUT /api/terminals/:id`，提交 `name` 和随机生成的 32 字节十六进制 `secret`。完全相同的登记可重试。设备凭据应通过 HTTPS 或本机连接提供，服务端只保存摘要。
- 通过 `PUT /api/terminals/:id/grants` 设置授权。提交 `conversationId`、`companionId`、`runtimeEpoch`、`workspaceId`、`tool: "diagnostic.echo"`、`enabled` 与 `expectedVersion`。首次登记用版本 0。授权和设备清单分别在 `GET /api/terminals/:id/grants` 与 `GET /api/terminals` 查询。
- 登录后以相同的领域范围、`terminalId`、UUID `requestId` 与 `arguments: { "text": "诊断文本" }` 调用 `POST /api/terminals/actions`。可带确切原文 `source: { messageId, contentVersion }`。按返回的动作 ID 查询 `GET /api/terminals/actions/:id`。未领取的动作可由 `POST /api/terminals/actions/:id/cancel` 撤销。
- 设备凭 `Authorization: Bearer <secret>` 调用对应设备下的 `connect`、`heartbeat`、`claim`、`disconnect` 和 `actions/:id/receipt`。连接返回新连接 ID。领取返回唯一动作及领取令牌。回执可在重连后携带原领取令牌核对。账号可用 `POST /api/terminals/:id/revoke` 撤销设备凭据。
- 心跳期限默认 45 秒，动作等待期限默认 120 秒，可在 `TERMINAL_CONFIG_JSON` 设置 `heartbeatTimeoutMs` 和 `actionTimeoutMs`。发送前会检查期限。领取响应丢失、设备断线或派发过期时，已经登记派发的动作进入未知状态，保留原身份待核对。原领取令牌和相同回执可重放。

## 测试终端

将 `TEST_TERMINAL_ID`、`TEST_TERMINAL_SECRET`、`TEST_TERMINAL_URL`、`TEST_TERMINAL_WORKSPACE` 和 `TEST_TERMINAL_JOURNAL` 设置为隔离测试环境的参数。回执目录使用绝对路径。运行 `pnpm test:terminal`，它会连接、登记心跳、领取诊断、先持久保存回执，再提交结果。进程重启会先发送已落盘的回执。无法确定的旧派发保留在后台状态中。

## 升级与验证

已有库执行 `pnpm db:migrate` 应用 `0002_terminals`，原有会话和任务保留。消息删除和实例清理会擦除有关动作的载荷，其他实例的授权与回执按原范围保留。

`pnpm verify:f12` 使用 `TEST_DATABASE_URL` 与 `TEST_REDIS_URL` 指向隔离测试服务。验收覆盖未授权请求、并发领取、应用重启后的回执核对、工作区切换与心跳过期、来源删除，以及独立测试终端进程。
