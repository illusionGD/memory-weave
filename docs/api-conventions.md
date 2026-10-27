# HTTP API 公共约定

所有终端共用 `packages/contracts/src/api.ts` 的数字码、默认提示和响应 schema。当前普通 JSON HTTP API 统一返回 `{ code, data, message }`，接口以 `/api` 为前缀。

## 统一格式

登录成功，HTTP 200：

```json
{
  "code": 200,
  "data": { "authenticated": true },
  "message": "操作成功。"
}
```

版本冲突，HTTP 409：

```json
{
  "code": 40902,
  "data": null,
  "message": "数据版本已变化，请刷新后核对。"
}
```

| 字段      | 语义                                                                             |
| --------- | -------------------------------------------------------------------------------- |
| `code`    | 数字响应码，可以引用共享常量，也可以使用业务自定义数字，不要求预先登记           |
| `data`    | 具体接口的业务对象、列表等；无数据和失败时为 `null`，字段不省略                  |
| `message` | 可展示的业务提示；共享目录提供默认值，业务可覆盖或自定义，不能用文案判断业务行为 |

HTTP 状态表示本次请求成功还是失败，`code` 表达业务结果。通用码沿用 200、201、400、401、404 等 HTTP 数值，已登记的具体业务码采用五位数字；自定义码没有位数和登记要求。例如 `code: 10001` 可以对应 HTTP 409，HTTP 状态不能通过对 code 做除法或区间判断得出。

GET、PATCH、登录和退出登录成功为 HTTP 200。F02 创建、保存、发布和接收仍为 HTTP 201，包括幂等重放。退出登录返回 `{ code: 200, data: null, message: '操作成功。' }`，不再使用 204 空响应。

原领域 schema 继续描述 `data` 内的对象。例如 `SessionResponse` 是登录业务数据，完整响应类型为 `ApiResponse<SessionResponse>`；分页的 `items` 和游标也放在 `data` 中。静态 HTML、JavaScript 等文件不使用 JSON 外层；HEAD 按 HTTP 规范不返回正文。未来文件下载、SSE 和 WebSocket 单独定义传输协议。

## 常用码的统一维护

| 内容                     | 维护入口                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| 常用数字码               | `API_CODES`；`ApiCode` 是当前已登记码的联合类型                                                          |
| 对应 HTTP 状态和默认提示 | `API_RESPONSES`；`getApiResponseDefinition(code)` 查询，未登记时为 `undefined`                           |
| 默认响应码               | 成功直接使用 HTTP 状态；`defaultApiErrorCode(status)` 查公共目录，已登记错误状态返回自身，其他值兜底 500 |
| 完整响应及其类型         | `apiResponseSchema`、`ApiResponse<T>`                                                                    |
| 失败响应                 | `apiErrorResponseSchema`、`ApiErrorResponse`，固定 `data: null`                                          |
| 已登记码枚举             | `apiCodeSchema`；仅在需要限制到目录时使用，普通 HTTP 响应不使用它拒绝自定义码                            |
| 追踪头                   | `REQUEST_ID_HEADER`，值为 `X-Request-Id`                                                                 |

```ts
import { API_CODES, API_RESPONSES, defaultApiErrorCode } from '@memory-weave/contracts';

API_CODES.OK; // 200
API_CODES.INVALID_CREDENTIALS; // 40101
API_CODES.VERSION_CONFLICT; // 40902
defaultApiErrorCode(409); // 409
defaultApiErrorCode(599); // 500，未登记的状态使用通用错误
API_RESPONSES[API_CODES.VERSION_CONFLICT];
// { statusCode: 409, message: '数据版本已变化，请刷新后核对。' }
```

新增需要跨模块或跨终端复用的码，在 `API_CODES` 登记名称和数字，再在 `API_RESPONSES` 补上默认 HTTP 状态与提示，类型检查会检查遗漏。数字不得与已有定义冲突，已交付的数字语义应保持稳定。仅局部使用的业务码与提示可以直接提供；调用方需要根据该码分支时，应在相应接口说明中约定其含义。

## 服务端接入

普通控制器直接返回领域数据，`ApiResponseInterceptor` 统一包装一次。无需在每个 controller 手工拼接外层。同名的业务字段如 `code`、`data`、`message` 会原样保留在业务数据内，不会被误判为已包装响应。

成功时按需自定义：

```ts
return new ApiResult(result, { code: 10000, message: '记录已保存。' });
return new ApiResult(result, { message: '本轮处理已完成。' });
```

`ApiResult` 与 `ApiResponseInterceptor` 维护在 `apps/server/src/http/api-response.interceptor.ts`。省略 code 时直接使用 HTTP 状态值；省略 message 时依次采用该码默认提示、该 HTTP 状态的默认提示、通用成功提示。HTTP 状态仍通过 Nest 的 `@HttpCode` 等接口声明。通用码与 HTTP 状态相同，不额外维护一份数字到相同数字的映射；业务码到 HTTP 状态的关系保存在 `API_RESPONSES`。

失败时：

```ts
// 共享码，使用目录中的 HTTP 状态和文案。
throw new ApiException(API_CODES.VERSION_CONFLICT);

// 共享码，覆盖本接口的提示。
throw new ApiException(API_CODES.INVALID_CREDENTIALS, '此入口的密码不正确，请重新输入。');

// 局部自定义码，无需登记；第三个参数指定 HTTP 错误状态。
throw new ApiException(10001, '当前伴侣正在休息。', 409);
```

`ApiException(code, message?, statusCode?)` 使用显式参数覆盖默认值。未登记的码未指定 HTTP 状态时默认 400；省略文案时使用对应 HTTP 状态的默认错误提示。仅要求 code 为 JSON 可表达的数字、错误 HTTP 状态为 400～599。自定义文案是业务明确声明可对外展示的内容，不应传入数据库异常、请求原文或凭据。

异常类 `ApiException`、统一输出 `sendApiError`、请求追踪中间件和 `ApiExceptionFilter` 合并维护在 `apps/server/src/http/api-exception.ts`。中间件直接调用 `sendApiError(response, new ApiException(...))`；控制器和服务抛出 `ApiException`。普通框架异常忽略原始正文、按状态提供默认提示；未知异常统一返回安全的 500。

数据库错误仍在数据库入口按约束、唯一冲突和服务不可用进行分类。响应外层不会改变事务、幂等或权限判断。

## 终端读取与兼容

Web 的公共请求层负责解包，页面和 store 继续使用领域数据：

1. 先按真实 HTTP 状态判断成功或失败。
2. 成功时校验 `apiResponseSchema`，再用具体接口 schema 校验 `data`，只把业务数据交给页面。
3. 失败时校验 `apiErrorResponseSchema`；保留数字 code 和业务返回的 message，包括未登记码、负数码和自定义文案。码表是默认值目录，不是白名单。
4. 遇到旧格式、字符串 code、缺失字段或代理 HTML，按 HTTP 状态给出共享默认提示，不展示这些不符合协议的内容。
5. 网络失败或本地超时没有完整响应，`ApiError.status`、`code` 为 null；提供网络或超时提示。请求与正文读取共用超时，不自动重试写操作。

提示在页面中按纯文本显示，不作为 HTML 渲染。需要业务行为分支时比较 code；认证状态仍根据实际 HTTP 401 处理。即使退出登录等操作不需要业务数据，也必须读取并校验统一外层。

本次属于响应协议升级：成功数据移入 `data`，错误 code 从字符串改为数字，`statusCode` 和追踪 `requestId` 不再放入正文。前后端应一起更新；旧版终端需要适配。原有领域数据和业务幂等键保持原义，无数据库迁移。

## 请求追踪与幂等

每次 HTTP 请求由服务端生成新的 `X-Request-Id`，不采用客户端提供的同名头。成功和失败都带该响应头，错误日志 `http.request.failed` 使用同一编号；日志仅含事件、追踪编号、实际 HTTP 状态及数字码，不记录业务提示或原始异常。

HTTP 追踪编号与创建、发布、接收命令中的业务 `requestId` 分开。重试同一业务命令保留其原幂等键和载荷，每次 HTTP 尝试仍获得新追踪编号。不能因超时自动换键重发写请求。

## 本地验收

按 README 启动后，在 Windows 另开终端执行（其他系统使用 `curl`）：

```bash
curl.exe -i http://localhost:3000/api/auth/session
curl.exe -i http://localhost:3000/api/health/live
curl.exe -i http://localhost:3000/api/missing
```

依次返回 HTTP 401/code 401、HTTP 200/code 200、HTTP 404/code 404，正文都只有 `code/data/message` 外层；健康数据为 `data: { status: 'ok' }`，失败为 `data: null`。追踪编号查看响应头。这些命令不创建伴侣或聊天数据。

`pnpm verify:f02` 会先构建共享契约，再通过同一 schema 校验响应并读取 `data`；它按原约定创建并保留验收数据。完整验证记录见 [开发进度](progress.md)。
