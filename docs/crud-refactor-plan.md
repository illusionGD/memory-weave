# 后端 CRUD 封装方案

日期：2026-11-03。状态：方案供 review，尚未修改业务实现；本轮覆盖范围等待用户选择。

## 目标与推荐

减少业务服务中反复出现的 `select().from().where()`、单行数组解包、普通插入/更新、归属条件和游标分页代码。保持现有 Drizzle、MySQL、接口响应和业务行为。

推荐采用「统一基础 CRUD + 按业务模块按需组合 Repository」：基础能力只实现一次，各表绑定自己的 schema、操作能力和当前数据库连接；需要复用的复杂查询放到所属业务模块。普通表无需各写一份相同的增删改查类，也不要求每张表单独建文件。

Repository 在这里指服务端内部的数据访问模块，不是新增 HTTP CRUD 接口。参数由经过校验的服务端代码构造，不把请求中的任意表名、字段名或条件直接转给数据库。

## 当前代码依据

代码检查发现 `apps/server/src/modules` 中约 374 处增删改查调用匹配，另外有 18 处显式行锁及 18 处重复键处理匹配；这是源码匹配数，不代表独立 SQL 数或全部都适合改成通用方法。

- [DatabaseService](../apps/server/src/database/database.service.ts) 已统一连接、持久 owner、迁移就绪检查和数据库异常分类，可直接复用。
- [WorkspaceService](../apps/server/src/modules/workspace/workspace.service.ts) 的资料读取与改名，是适合基础 CRUD 的简单场景。
- [PersonaTemplatesService](../apps/server/src/modules/companions/persona-templates.service.ts) 同时包含普通读取、关联历史版本、幂等插入和事务行锁。它可验证基础方法与自定义查询如何共同工作。
- [会话访问检查](../apps/server/src/modules/conversations/conversation-access.ts) 除查询外，还校验代次、成员、可见区间及清理状态。这些判断需要保留明确语义。
- [TaskStore](../apps/server/src/modules/tasks/task-store.ts) 规定调度事务、数据库时间和锁顺序，CRUD 封装必须使用调用方传入的事务。
- [数据库 schema](../apps/server/src/database/schema.ts) 包含没有普通 `id` 字段的配置指针表，以及需要保留不可变历史的版本表。不能为所有表默认开放同样的修改和删除入口。

## 方案比较

| 方案                       | 优点                                 | 对本项目的代价                                     | 结论                           |
| -------------------------- | ------------------------------------ | -------------------------------------------------- | ------------------------------ |
| 每张表手写完整 CRUD        | 定制直接，代码入口容易找             | 查询模板、类型与归属逻辑重复，维护文件增加         | 有明确特殊需求时才增加专用方法 |
| 全部收进一个万能 CRUD      | 表面调用统一                         | 联表、行锁、版本、任务租约与清理规则使参数不断膨胀 | 仅统一基础操作，不承担领域规则 |
| 通用基础 + 模块 Repository | 简单操作共用实现，复杂查询有明确归属 | 需要明确事务和操作能力，首批先验证泛型推导         | 推荐                           |

不更换 ORM，不添加新的数据库访问依赖。Drizzle 已提供参数化查询、类型化表达式和事务，封装直接组合这些能力。

## 调用方式草案

以下示例表示拟提供的 API，尚未实现。`companionRows` 在使用前已绑定当前 owner 与本次 `db` 或 `tx`。

原来：

```ts
const [row] = await tx
  .select()
  .from(companions)
  .where(and(eq(companions.ownerId, ownerId), eq(companions.id, id)))
  .limit(1);
```

封装后：

```ts
const companionRows = companionTable.bind(tx, ownerId);
const row = await companionRows.findOne({ where: { id } });
```

带多个简单条件：

```ts
const member = await memberRows.findOne({
  where: { conversationId, companionId, runtimeEpoch, kind: 'companion' },
});
```

需要范围、OR、子查询等表达式时，继续接收 Drizzle 类型化条件，不另外发明一套完整的查询语言：

```ts
const rows = await messageRows.findMany({
  where: and(eq(messages.conversationId, conversationId), gt(messages.sequence, afterSequence)),
  orderBy: [asc(messages.sequence)],
  limit: limit + 1,
});
```

数据查询结果仍需经过现有的成员可见性、人生代次和生命周期检查；仅限定 owner 不能替代这些规则。

## 基础能力及行为

| 能力                    | 约定                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `findOne`               | 有匹配返回类型化行，无匹配返回 `null`；不统一假定缺失都应返回 404                  |
| `findMany`              | 支持类型化筛选、排序、选择字段和有界条数；分页保持现有游标语义                     |
| `exists` / `count`      | 通过对应数据库查询执行，不加载全部记录后计算                                       |
| `insert` / `insertMany` | 保留 schema 默认值和字段类型，批量操作不循环发送单条写入                           |
| `updateWhere`           | 必须有明确筛选，保留原子条件与受影响行数；由调用方判断冲突或未找到                 |
| `deleteWhere`           | 仅向明确允许物理删除的内部访问模块开放，要求明确筛选；业务删除继续进入生命周期服务 |
| UUID 游标辅助           | 仅用于现有按 ID 排序的场景；序号、时间线及图谱使用各自的排序与游标                 |

补充约定：

1. 使用 Drizzle schema 推导行类型、插入/更新字段、投影结果；错误字段名或值类型在编译时失败，对外不以 `any` 抹平类型。
2. 简单对象条件表示 AND 等值匹配，`null` 明确转换为 `IS NULL`；显式传入 `undefined` 的条件报错，不静默丢弃。复杂可选条件继续使用 Drizzle 表达式。
3. 更新、删除拒绝缺省或空条件，不能由于 `id` 为 `undefined` 意外扩大范围。该保护无法判断人为构造的恒真 SQL 表达式，后者只允许受信任的内部代码使用。
4. 含 owner 的表在绑定时固定 owner，读写统一加入归属条件，插入自动附加 owner，更新不能改 owner；`owners.id` 等特殊归属列显式配置。不猜测所有表都有 `id` 或 `ownerId`。
5. 事务绑定创建新的访问实例，不修改共享对象的连接。事务内所有方法和自定义查询使用同一 `tx`；通用方法不偷偷打开新连接、不自行提交、不增加嵌套事务。
6. 行锁只允许在事务绑定中请求，保留原锁顺序、READ COMMITTED、条件更新和数据库时间。不能将原子更新改成先读后写。
7. 默认不引入自动 upsert、软删除、保存钩子或失败重试。现有幂等命令保留唯一键、指纹校验、无覆盖重复键处理和结果回读，避免覆盖历史或重复发布。
8. MySQL 插入/更新不承诺返回完整新行；基础写入返回明确的写入结果，需要默认值或公共响应时由模块查询构造。更新与删除保留 `affectedRows` 语义，不把 0 行统一转成一种 HTTP 错误。
9. 版本表日常访问只开放读取和追加；生命周期清理使用单独的受控写入路径。任务租约更新、消息发布与来源传播使用具名业务操作。
10. 继续由现有 DatabaseService 与 API 异常机制处理错误；不重新增加一套 HTTP 返回包装，也不改共享响应码。

## 文件组织建议

```text
apps/server/src/database/
  database.service.ts        # 现有连接、owner 与错误分类
  crud-types.ts              # schema 推导、连接和参数类型
  table-repository.ts        # 基础 CRUD 与归属绑定
  cursor-pagination.ts       # 可复用的 ID 游标结果整理

apps/server/src/modules/companions/
  companion.repository.ts    # 按需组合相关表、承载复用的复杂查询
  persona-templates.service.ts
```

名称与文件数量按首批实现验证后确定，不为了目录对称创建空类、空 Repository 或 Controller。已有 `*-access.ts` 与 `*-store.ts` 可以继续保留语义明确的方法，避免机械移动代码。

## 范围选项与任务

待用户选择：

- **推荐范围**：统一基础 CRUD，覆盖后端适合的简单单表操作；复杂查询按复用需要整理，事务、联表与领域逻辑可以继续明确存在于现有模块。
- **扩大范围**：在上述基础上，将全部数据库读写收进各模块 Repository。需要更多文件调整与全面回归，收益主要是统一代码分层，而不只是减少重复写法。

本次不改 HTTP 协议、数据库结构、迁移文件、模型行为、Redis 或 Qdrant。正常使用无需清库或 SQL 迁移。

| 优先级 | 任务                            | 依赖             | 验收                                                                                           |
| ------ | ------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| P0     | [ ] C01 基础能力与类型验证      | 方案与范围确认   | 字段/投影推导、空条件拒绝、owner 固定、事务不逃逸；真实 MySQL 验证                             |
| P0     | [ ] C02 资料与模板首批接入      | C01              | 改名、模板历史、幂等重放与版本冲突保持一致；自定义联表可继续使用同一事务                       |
| P0     | [ ] C03 按模块替换普通重复操作  | C02              | 实例、会话、聊天、任务、模型、记忆等模块逐批接入；每批保持原协议与生命周期语义                 |
| P0     | [ ] C04 回归、文档与交付        | C03              | 类型/lint/构建及受影响真实 HTTP 测试通过；代表性浏览器流程通过；开发规范说明新旧查询的使用方式 |
| P1     | [ ] C05 全部访问收进 Repository | 仅扩大范围时纳入 | 服务层无直接表查询，复杂事务仍保持连接与锁顺序，全面回归通过                                   |

若用户选择扩大范围，C05 升为 P0，并在 C04 最终回归之前完成。先完成 C01/C02 验证参数与类型设计，再扩展到其他模块。分批验证不重复请求已确认范围内的授权。沿用 `dev` 分支与现有提交推送约定；完成后保留永久说明，删除本临时计划。

## 验证重点

- 通过真实 MySQL 或既有 HTTP 入口验证行为，不 mock Repository 内部查询链。
- owner 隔离、不可见/不存在、默认值、空结果、空条件、nullable 字段和批量写入。
- 同一事务内先写后读及回滚；并发原子更新、原行锁和死锁避免顺序保持。
- 重复命令仍返回原结果；同幂等键不同内容仍冲突；陈旧版本和代次仍拒绝。
- 不改变游标排序、时间线边界、来源过滤与生命周期清理范围。
- 优先复用现有用例；新增测试针对封装引入的边界，避免逐方法重复验证 Drizzle 自身行为。
- 比较代表性操作的 SQL 和请求次数，基础封装不自动回读、不引入 N+1 或额外 count 查询；不在未测量时声称性能提升。
