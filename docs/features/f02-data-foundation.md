# F02 数据与会话基础

本功能为后续模型调用、人格成长和记忆整理建立持久数据入口。比较基线为 `af55db5`；当前交付状态和检查结果见 [开发进度](../progress.md)。

## 技术与边界

沿用 Node 22、NestJS、PostgreSQL 17 / pgvector，使用 Drizzle ORM 0.45.4（Apache-2.0）和 drizzle-kit 0.31.11（MIT）。公共请求与响应放在 `packages/contracts`，Zod 校验与 TypeScript 类型共用定义，字段保留中文提示。

本轮可以通过 HTTP 创建基础实例、用户与伴侣私聊、伴侣之间私聊及多人群聊，保存和发布原文，按伴侣视角查询、接收和回查来源。初始人生暂存为文本，不调用模型解析或自动发展；完整创建页面、聊天生成、任务调度、记忆提取及成员变更属于后续功能。

当前接口由已登录的部署管理者操作。管理者可以查看所属实例，也可以代理指定伴侣发言或接收，以验证数据流；伴侣发言的来源明确记录为 `admin_companion_input`。此处尚无自主模型发言或独立终端身份凭据。

用户资料包含可修改的 `displayName`，默认“用户”，可在 `/settings` 的个人设置页维护。修改名称不改变 owner ID、登录密码、会话成员或历史原文；伴侣对用户的个别称呼不由这个全局名称字段替代。现有数据库通过新增 `0001_owner_display_name` 迁移补上默认名称，保留原 owner 和关联数据。

## 数据如何分开

| 对象       | 保存内容与约束                                                                 |
| ---------- | ------------------------------------------------------------------------------ |
| 管理者     | 迁移时生成一次的部署 owner；重启不变，请求不能指定 ownerId                     |
| 实例       | 稳定 ID、运行代次、独立初始快照和当前人格版本引用；F02 均从第 1 版开始         |
| 人格版本   | 当前人格独立存储，初始快照不会因当前版本变化而被覆盖；本轮没有修改接口         |
| 会话与成员 | 共享会话不归单个伴侣所有；成员携带代次、加入/离开序号与权限版本                |
| 可见授权   | 成员期间和历史授权分别建模；本轮只建立初始成员授权，不开放扩权                 |
| 原文       | 同一发布消息只存一份，区分草稿、发布状态、内容版本、修订号和发布序号           |
| 来源       | 指向确切的消息 ID 和内容版本，注明引用或转述；本轮只允许同会话内合法已发布来源 |
| 接收批次   | 保存本次实际选择的消息集合；重试不因新增消息而改变原批次                       |
| 读取记录   | 每实例、代次、消息版本独立保存取得时间与完整文本范围，范围按 UTF-16 计数       |
| 待整理区间 | 发布时为各可见伴侣原子登记；逐条保存，状态只有 pending，不冒充已完成整理       |

`occurredAt` 表示内容所述的发生时间，未知时为 null；`receivedAt` 是服务端保存时间；`publishedAt` 是发布成功时间。`validFrom` / `validUntil` 表示内容适用时段，未知保持 null。陈述、转述、推断、设定以及现实/虚构性质分别保存，不能由这些字段改变发言者身份或访问权限。

普通 GET 不产生已读记录。显式接收表示服务端为该实例取得完整正文，不意味着模型理解、记忆提取完成或用户终端成功交付。A 的接收不会代替 B 的接收。

## HTTP 接口

以下均以 `/api` 为前缀并要求登录 Cookie。创建命令使用 UUID `requestId`：同作用域同键同载荷重试复用结果，异载荷返回 409。

| 接口                                                                  | 用途                                       |
| --------------------------------------------------------------------- | ------------------------------------------ |
| `GET /workspace`                                                      | 当前持久 owner、显示名称与基础 schema 版本 |
| `PATCH /workspace`                                                    | 修改当前用户的显示名称，返回完整工作区资料 |
| `POST /companions`；`GET /companions`；`GET /companions/:id`          | 创建、分页、读取实例及初始/当前人格        |
| `POST /conversations`；`GET /conversations`；`GET /conversations/:id` | 创建、分页、读取会话及成员授权             |
| `POST /conversations/:id/messages`                                    | 保存草稿，不分配发布序号                   |
| `POST /conversations/:id/messages/:messageId/publish`                 | 校验预期版本，发布并登记各实例待整理项     |
| `GET /conversations/:id/messages`                                     | 管理者查询已发布原文                       |
| `GET /conversations/:id/messages/:messageId`                          | 管理者查询详情，允许查看草稿               |
| `GET /companions/:companionId/conversations/:id/messages`             | 按指定实例权限查询已发布消息               |
| `GET /companions/:companionId/sources/:messageId`                     | 按指定实例权限回查确切内容版本             |
| `POST /companions/:companionId/conversations/:id/receive`             | 接收确切批次并记录实际取得范围             |
| `GET /companions/:companionId/conversations/:id/progress`             | 查询逐消息读取记录、待整理和交付状态       |

伴侣查询必须带 `runtimeEpoch`；来源查询还需 `contentVersion`。接收命令需 `expectedPermissionVersion`。保存草稿需 `expectedConversationVersion`；发布还需 `expectedRevision`。陈旧代次或版本拒绝执行，服务端不会自动替调用方换成最新值。

实例/会话按 `afterId` 分页；原文/进度按 `afterSequence` 分页，默认 0。`limit` 默认 20，最大 100。列表响应有 `items` 和下一页游标；接收响应的 `nextAfterSequence` 是本批最后序号，空批为 null，不承诺没有后续新消息。

名称和会话标题最多 80 字符；初始文本与消息正文最多 4000 字符；每条消息最多 10 个来源引用。时间为 UTC ISO 字符串。私聊恰好两名参与者，群聊创建时为 3～20 名参与者。完整字段、默认值和空值语义以公共 schema 为准。

参数错误 400，未登录 401，不存在或不可见 404，幂等/版本冲突 409，数据库或迁移未就绪 503。响应不返回连接串、SQL 或请求指纹。

资料修改只接收 `{ "displayName": "新名称" }`，去掉首尾空白后校验 1～80 字符；空白、超长及额外身份字段返回 400。该操作更新当前名称，不需要创建命令的 `requestId`；重复提交同一名称不会产生新身份。消息继续使用稳定 `userId`，展示时通过工作区资料取得当前名称，不改写原文中的旧称呼。

## 数据库迁移与部署

开发环境先启动数据库，再运行 `pnpm db:migrate`，最后 `pnpm dev`；Windows 和 Linux 使用相同命令。`pnpm db:status` 只读检查。命令只依赖 `DATABASE_URL`，不需要登录密码或模型密钥。

生产镜像包含编译后的维护 CLI 与 `drizzle` SQL/journal。Compose 按“数据库可连接 → migrate 成功退出 → app 启动”执行。已有 F01 数据卷直接升级；数据库探活只检查可连接，避免首次安装 vector 之前就阻塞迁移。

迁移使用独立数据库连接上的 advisory lock，使并发部署串行；执行前后校验数据库历史是当前发布包的严格前缀，包括顺序、时间和 SQL hash。历史被改写、缺失、跳过或超出当前代码版本时拒绝继续。SQL 文件统一 LF，避免 Windows 换行造成 hash 不一致。待执行 SQL 在事务中执行，失败回滚，不提供自动降级。

新增结构时编辑 `apps/server/src/database/schema.ts`，运行 `pnpm --filter @memory-weave/server db:generate`，审查并提交新 SQL、snapshot 和 journal。**已交付的迁移文件不能改写**；后续修正必须增加迁移。不能通过清空历史绕过校验。

`/api/health/live` 不依赖数据库；`/api/health/ready` 要求数据库、vector、结构版本和附件目录同时就绪。登录后的状态页显示结构“已就绪 / 待升级 / 暂不可用”，健康检查本身不执行迁移。

迁移设计参考 [Drizzle migrations](https://orm.drizzle.team/docs/migrations)、[Drizzle migrate](https://orm.drizzle.team/docs/drizzle-kit-migrate) 和 [PostgreSQL advisory locks](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS)。Drizzle 原生执行器之外增加了并发与历史一致性保护。

## 本地验收

按 [README](../../README.md) 启动服务，在仓库根目录另开终端运行：

```bash
pnpm verify:f02
```

脚本使用 `.env` 的 `ADMIN_PASSWORD`，优先访问 `VERIFY_BASE_URL`，其次 `APP_ORIGIN`，最后 `http://localhost:3000`。它会永久创建带验收名称的 A/B/C 实例及会话，打印创建 ID 和各项结果，不会清除已有数据。重复运行会创建新的一组数据。本轮尚未提供删除实例功能。

验收覆盖创建、草稿不可见、发布、引用来源、各实例独立读取、幂等接收及非成员访问被拒绝。浏览器本轮仍以运行状态为主，完整伴侣和聊天界面按后续功能推进。

自动 HTTP 测试必须显式配置独立 `TEST_DATABASE_URL`，测试角色需有创建临时数据库和 vector 扩展的权限。各测试套件创建随机命名库并清理自己创建的库，不向业务库灌表。迁移测试通过维护命令验证重复执行、并发、历史校验和失败回滚；领域行为通过认证 HTTP 验证。
