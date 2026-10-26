# HTTP API 公共约定

所有终端使用同一套协议。请求与成功响应的 schema、类型和错误目录统一维护在 `packages/contracts`；本说明面向 Web、未来 App、桌宠及其他接口调用方。当前实现覆盖普通 JSON HTTP API，接口以 `/api` 为前缀。

## 唯一维护入口

| 内容                            | 维护位置                                                  |
| ------------------------------- | --------------------------------------------------------- |
| 业务请求、成功响应及分页        | `packages/contracts/src` 各领域 schema                    |
| 错误码、HTTP 状态、中文默认提示 | `packages/contracts/src/errors.ts` 的 `API_ERRORS`        |
| 错误响应校验与类型              | `apiErrorResponseSchema`、`ApiErrorResponse`              |
| 当前已知错误码                  | `apiErrorCodeSchema`、`ApiErrorCode`                      |
| 追踪响应头名称                  | `REQUEST_ID_HEADER`，值为 `X-Request-Id`                  |
| server 业务异常                 | `apps/server/src/http/api-exception.ts`                   |
| server 统一响应出口             | `apps/server/src/http/error-response.ts` 与全局异常过滤器 |
| Web 请求适配                    | `apps/web/src/services/http.ts`                           |

TypeScript 终端从 `@memory-weave/contracts` 导入，不另抄一套接口类型或错误文案。其他语言按本协议实现 HTTP 适配，字段及错误码以共享目录为准。业务代码不能自行拼装另一种失败格式。

## 成功响应

保留各接口的业务对象，按对应 schema 校验，不额外包裹通用的 `code/message/data`。成功依靠实际 HTTP 状态判断；不能用 HTTP 200 携带业务失败。

当前 GET、PATCH 和登录成功返回 200；F02 的 POST 创建、保存、发布及接收操作沿用 201，包括幂等重放；退出登录为 204，正文为空。列表继续使用 `items` 及对应的下一页游标，终端按该接口的 schema 读取。

所有应用处理的 HTTP 响应带 `X-Request-Id`。成功正文不增加追踪字段，避免改变既有对象和幂等重放结果。

## 错误响应

例如 HTTP 409：

```json
{
  "statusCode": 409,
  "code": "VERSION_CONFLICT",
  "message": "数据版本已变化，请刷新后核对。",
  "requestId": "e4f34b29-3f5d-4f37-9266-4764bbd61cee"
}
```

| 字段         | 语义                                                                             |
| ------------ | -------------------------------------------------------------------------------- |
| `statusCode` | 与实际 HTTP 状态一致的 400–599 整数                                              |
| `code`       | 稳定业务标识，终端据此决定处理方式，最多 80 个大写字母、数字和下划线，以字母开头 |
| `message`    | 共享目录提供的安全中文提示，可调整措辞；不能用它判断业务类型                     |
| `requestId`  | 本次 HTTP 请求的服务端 UUID，与 `X-Request-Id` 一致                              |

参数校验、认证守卫、业务异常、JSON 解析失败、超大请求体、来源校验、未知路由与未预期异常均使用这一格式。正文不包含请求值、凭据、SQL、连接串、原始异常或堆栈。

终端应区别处理同一状态码下的原因。例如：

| 错误码                        | HTTP | 处理含义                                 |
| ----------------------------- | ---- | ---------------------------------------- |
| `AUTH_REQUIRED`               | 401  | 当前会话无效，回到登录                   |
| `INVALID_CREDENTIALS`         | 401  | 登录密码不正确，留在登录表单             |
| `INVALID_REQUEST`             | 400  | 请求不符合接口契约，需要修正输入         |
| `RESOURCE_NOT_FOUND`          | 404  | 资源不存在或不可见，两个情况不额外区分   |
| `IDEMPOTENCY_CONFLICT`        | 409  | 相同业务幂等键使用了不同内容，核对原命令 |
| `VERSION_CONFLICT`            | 409  | 先读取最新数据，再决定是否重新提交       |
| `RUNTIME_EPOCH_MISMATCH`      | 409  | 实例代次已变化，禁止替旧命令自动换代次   |
| `PERMISSION_VERSION_CONFLICT` | 409  | 重新读取会话权限和可见范围               |
| `RATE_LIMITED`                | 429  | 暂停重试，稍后再操作                     |
| `DATA_UNAVAILABLE`            | 503  | 数据服务、结构或必要记录尚未就绪         |
| `INTERNAL_ERROR`              | 500  | 未被业务层分类的内部异常，只返回安全提示 |

完整错误码及文案只在 `API_ERRORS` 维护。数据库入口将约束错误转为 400、唯一约束冲突转为 409、可识别的其他数据库错误转为 503；不带数据库错误码的未知异常继续交给全局 500 处理。框架 `HttpException` 按状态降级为共享通用错误，忽略其原始正文；未登记的框架状态降级为 500。

## 请求追踪与幂等

`X-Request-Id` 由 server 对每次 HTTP 请求重新生成，不采用客户端传入的同名头。失败响应与结构化日志 `http.request.failed` 使用同一编号；日志只含事件名、追踪编号、HTTP 状态和业务错误码。

它与创建、发布、接收命令正文中的业务 `requestId` 含义不同：重试同一命令要保留原业务幂等键及载荷；每次 HTTP 尝试都会得到新的追踪编号。终端不能拿追踪编号充当业务幂等键，也不能因为收到 500 或超时就自动换键重发写请求。先核对状态或按原命令的幂等规则处理。

发生问题时可在浏览器 Network 或终端网络日志中取得追踪编号，对照后端日志定位错误类别。代理自身生成的响应可能没有此编号。

## 旧终端与异常响应

服务端只抛出 `ApiErrorCode` 已登记的值，但跨版本响应的 `code` 字段允许新增值。因此终端读取错误时使用 `apiErrorResponseSchema`，不能用当前版本的错误码枚举拒绝整个响应。

Web 当前按以下顺序处理，其他终端应保持相同行为：

1. 以实际 HTTP 状态判断成功与失败，再校验错误正文，检查正文状态与 HTTP 一致；已知码还需匹配登记的状态。
2. 已知错误码从共享目录选择提示，按业务码决定处理方式；提示文字不是分支条件。
3. 未知但合法的错误码保留到 `ApiError.code`，按实际 HTTP 状态显示通用提示；不直接展示未知远端文案。
4. 遇到旧错误格式、非 JSON、格式错误或状态不一致的正文，按实际 HTTP 状态降级，`code` 为 null。有效响应头中的追踪编号仍保留；正文与响应头编号不一致时不采用正文。
5. 网络失败和本地超时没有完整 HTTP 错误响应，`status`、`code` 为 null；仍提供网络或超时提示。Web 的超时覆盖请求和正文读取全过程。

现有成功正文和 HTTP 状态保持兼容；失败正文统一为四个字段，不再依赖 Nest 默认的 `error` 字段。依赖旧错误格式的外部调用方应按此说明升级。新增错误码属于可扩展变化，不改变已有错误码的语义。

## 新功能如何接入

先在 `API_ERRORS` 增加错误码、HTTP 状态和默认中文提示，再在 server 业务代码中抛出：

```ts
throw new ApiException('VERSION_CONFLICT');
```

中间件使用同一个 `sendApiError` 出口。终端通过共享 schema 校验，并只为需要特殊动作的业务码增加处理，其余使用共享提示。补充对应公开 HTTP/Web 行为测试，不在每个 controller 重复写 try/catch 或错误格式。

后续 SSE、WebSocket 的连接建立前错误可以沿用 HTTP 约定；连接建立后的失败需要协议内事件，届时复用业务错误目录并定义事件结构。当前没有把已发送的流改写成 JSON，也未实现流内错误协议。

## 本地验收

启动应用后，在 Windows 另开终端执行（其他系统使用 `curl`）：

```bash
curl.exe -i http://localhost:3000/api/auth/session
curl.exe -i http://localhost:3000/api/health/live
curl.exe -i http://localhost:3000/api/missing
```

第一条不携带浏览器 Cookie，应返回 401 和 `AUTH_REQUIRED`；第二条返回 200，正文仍为 `{ "status": "ok" }`；第三条返回 404 和 `RESOURCE_NOT_FOUND`。每次均有新的 `X-Request-Id`，失败时与正文一致。这些检查不创建伴侣或聊天数据。

本次不增加数据库迁移或运行依赖。更新前后端代码并重新启动即可；具体验证结果见 [开发进度](progress.md)。
