# 后端基础 CRUD 与模块 Repository

用户已确认「统一基础 CRUD，复杂查询按需整理」。继续使用 Drizzle + MySQL，初版 C01–C04 已完成。2026-11-05 按用户要求将表入口集中到 `DatabaseService`，本次比较基线 `13664f0`。没有新增依赖、HTTP 接口或数据库迁移，拉取后重启后端即可使用。

## 入口与选择

- `database/tables.ts`：通过 `DatabaseTables` 集中声明 42 张表的属性、schema、归属字段和日常访问能力；基础方法仍共用一套实现。
- `database/database.service.ts`、`database-context.ts`：提供 `database.表.操作` 及事务内的 `tx.表.操作`；自动取得归属，普通连接与每个事务独立。
- `database/table-repository.ts`、`crud-types.ts`：共用查询、插入、更新及受控清理，类型由现有 Drizzle schema 推导。
- `database/cursor-pagination.ts`：整理现有按 UUID 排序的查询结果，不改变排序、不额外查询。
- `modules/companions/persona-template.repository.ts`：复用模板身份与历史版本的联表条件，是按需增加模块 Repository 的实例。

资料、伴侣、模板、会话、聊天、模型、任务、记忆、检索和生命周期模块已接入适合的普通读写。涉及行锁的读取、幂等重复键处理、关联查询、批量来源传播和受控历史清理继续明确保留在所属模块。本轮不要求所有数据库访问都搬进 Repository，不将领域权限和任务调度做成通用 CRUD 参数。

## 字段提示和返回类型

注入 `DatabaseService` 后可以直接查询，不需要导入 `tables` 或逐表调用 `bind`：

```ts
const row = await database.companions.findOne({ where: { id: companionId } });
// row：typeof companions.$inferSelect | null
// 输入 where、set 时提示该表字段；访问 row 时提示具体属性。

await database.companions.updateWhere({
  where: { id: companionId, version: expectedVersion },
  set: { name: '星遥', version: expectedVersion + 1 },
});
```

只选取部分字段时，返回类型也只有实际选择的字段，别名保留：

```ts
const rows = await database.conversations.findMany({
  where: { kind: 'private', lifecycleOperationId: null },
  fields: { label: conversations.title, at: conversations.createdAt },
  orderBy: [asc(conversations.id)],
  limit: 20,
});
// rows：{ label: string; at: Date }[]
```

拼错字段、把 `version` 写成字符串、给枚举字段传非法值、插入缺少必填字段或更新 `ownerId`，都会在类型检查时报错。输入和返回值不使用 `any`。模块 Repository 的返回类型也保留具体 schema 类型；不另外手写一套与表结构重复的通用行定义。

## 方法约定

| 方法                                                    | 行为                                                   |
| ------------------------------------------------------- | ------------------------------------------------------ |
| `findOne({ where?, fields?, lock? })`                   | 读取一行，缺失返回 `null`；调用方决定对应业务含义      |
| `findMany({ where?, fields?, orderBy?, limit, lock? })` | 必须指定正整数条数，支持现有 Drizzle 条件和排序        |
| `exists(where?)` / `count(where?)`                      | 数据库侧查询，不载入全部记录正文后判断                 |
| `insert(values)` / `insertMany(values)`                 | 自动附加归属；保留默认值、约束；批量插入只发送一条 SQL |
| `updateWhere({ where, set })`                           | 原子执行条件更新，保留版本条件；不先查再更新           |
| `deleteWhere(where)`                                    | 仅 `cleanup` 能力开放；用于明确的物理清理              |

所有写入返回 mysql2 的 `ResultSetHeader`，例如 `result.affectedRows`。不会自动回读新行、统计总量或把 0 行转成统一 HTTP 异常。需要回读的业务显式查询；版本冲突、找不到、幂等冲突继续由领域代码判断。

等值对象表示 AND：`{ id, state: 'published', deletedAt: null }`。`null` 变成 `IS NULL`，显式 `undefined` 条件会拒绝，避免意外扩大更新范围。复杂筛选继续使用 Drizzle 表达式：

```ts
const pageRows = await tx.messages.findMany({
  where: and(eq(messages.conversationId, conversationId), gt(messages.sequence, afterSequence)),
  orderBy: [asc(messages.sequence)],
  limit: limit + 1,
});
```

可选筛选使用 Drizzle 的条件组合，或只在参数存在时添加对象属性；不要传 `{ id: undefined }`。写入必须有明确且非空的 `where`。该保护不能判断受信任代码自行构造的恒真 SQL，不能把客户端的任意字段/条件原样转入 Repository。

`idCursorPage(rows, limit, row => row.id)` 只用于已按该 ID 排序且多取一条的结果。消息序号、时间线复合游标和图谱仍使用各自的分页规则。

## 归属、事务和访问能力

`database.companions` 等属性不会立即查询数据库；调用方法时，服务沿用原有结构就绪检查、持久 owner 查询和错误码转换。`database.withOwner` 可以让一组普通操作复用一次检查，其回调参数 `db` 也支持 `db.表.操作`；它本身不创建事务。含 `ownerId` 的表自动追加该条件；`owners` 明确使用 `id` 作为归属列。插入不能再传归属字段，更新不能修改归属字段。

owner 限定只是一层基础隔离。伴侣代次、会话成员、可见区间、来源版本及删除限制仍由现有领域方法校验；不能以基础 CRUD 替代它们。

通过 `database.transaction` 开启事务，回调内统一使用 `tx`：

```ts
await database.transaction(
  async (tx) => {
    const row = await tx.conversations.findOne({ where: { id }, lock: 'update' });
    // 后续操作继续使用 tx；database 的普通入口不会自动加入这个事务。
  },
  { isolationLevel: 'read committed' },
);
```

单表操作不偷偷开启事务；显式 `transaction` 回调成功时提交、抛错时回滚。每次事务创建独立上下文，不改变共享对象的连接。普通 `database` / `db` 请求行锁在编译期报错，运行期也检查实际事务对象；既有锁顺序、配置锁和调度锁保持原样。

复杂联表、幂等 upsert、历史清理等通过上下文的 `db.sql` / `tx.sql` 使用原始 Drizzle；它与该上下文中的基础 CRUD 使用同一连接。原有模块 Repository 接收该上下文，复杂查询内部使用 `.sql`。不要在事务回调中用外层 `database` 执行本应参与事务的操作。

表能力分为 `read`、`append`、`write`、`cleanup`。版本/证据等历史表日常只允许读取和追加；目前仅可重建的搜索文档与词项开放通用物理删除。生命周期对历史正文的擦除继续走原有显式清理协议，不为这些表开放普通改写或删除。

没有引入自动 upsert、软删除、重试、保存钩子或新的 HTTP 包装。数据库错误仍由 `DatabaseService` 与公共异常出口处理。表能力用于约束内部调用，不替代服务端权限验证。

## Review 与验证

新增真实 MySQL 用例通过公共 Repository 方法观察隔离、默认值、nullable 筛选、投影、批量插入、原子版本更新、空条件拒绝、归属保护、受控清理和事务回滚。编译期用例检查字段、枚举、投影和操作能力；不 mock 内部查询链。

在已取得连接和归属的上下文内，批量两行插入和列表查询的 SQL 日志分别确认只有一次查询，没有自动回读或额外 count；这不等于完成容量或性能压测。既有 HTTP 用例继续验证分页、幂等重放、历史版本、来源权限、模型计量、任务恢复和生命周期传播。

建议 review 顺序：`DatabaseService` / `DatabaseContext` / `DatabaseTables` → 基础类型与实现 → `WorkspaceService` → `PersonaTemplateRepository` 与模板服务 → 各业务模块替换。界面验收可以修改显示名称，创建伴侣与模板版本，发起聊天，再检查后台任务、记忆来源和删除/重置流程；用户可继续沿用原有 F02–F10 验收方式。

初版（2026-11-03）已完成以下验证：

- 完整后端回归 23 个文件、199 条用例全部通过，包含 5 条新增真实 MySQL Repository 用例。
- Node 22.23.4 下格式、lint、全工程类型检查和生产构建通过；TypeScript 编辑器服务实际提供条件/更新字段补全，投影结果只补全 `label`、`at`。
- 桌面与手机 30 条浏览器流程全部通过，覆盖资料改名、模板历史、聊天、头像、删除重置、记忆浏览与跨私聊来源。
- `pnpm deploy --prod` 生成独立生产包，原生 Node 完成 F02 14 项与 F05 14 项 HTTP 验收；重启后伴侣/人格公开快照和 Redis 登录仍保持。
- 语法树比较确认原有 18 处行锁查询、18 处重复键处理和 14 处事务隔离参数保持一致。基础封装没有增加领域锁或改变锁顺序。
- 本次未重建 Docker 镜像，也未部署到用户云服务器；生产依赖打包、原生 Node 启动与数据保留已验证。

2026-11-05 入口调整已完成验证：24 个后端文件、203 条用例和桌面/手机 30 条浏览器流程全部通过；新增 4 条真实 MySQL 用例覆盖直接访问与错误转换、结构未就绪、基础 CRUD 与原始 SQL 共用事务、回滚与并发事务隔离。格式、lint、全工程类型检查和构建通过；独立生产包完成 F02/F05 各 14 项验收，重启后伴侣/人格快照及登录状态保持。未新增数据库迁移，未重建 Docker 镜像或部署用户服务器。完整记录见 [开发进度](../progress.md)。
