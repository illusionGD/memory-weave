# 后端数据库访问

普通业务直接使用 `database.表.操作`，事务使用 `database.transaction`。不需要 `withOwner` 或手动绑定 owner。继续使用 Drizzle + mysql2，没有新增 ORM 或运行时依赖。

## 普通操作与类型

```ts
const companion = await database.companions.findOne({ where: { id: companionId } });
const rows = await database.companions.findMany({
  where: { deletedAt: null },
  fields: ['id', 'name'],
  limit: 20,
});
// rows: { id: string; name: string }[]

const result = await database.companions.updateWhere({
  where: { id: companionId, version: expectedVersion },
  set: { name: newName, version: expectedVersion + 1 },
});
// 用 affectedRows 判断原子更新是否成功，不先查再写。
```

| 方法                | 行为                                                |
| ------------------- | --------------------------------------------------- |
| findOne             | 缺失返回 null                                       |
| findMany            | 必填正整数 limit，支持排序、投影与现有游标          |
| exists / count      | 在数据库侧判断或计数，不读取全部正文                |
| insert / insertMany | 自动附加归属，批量插入只发送一条 SQL                |
| updateWhere         | 必须有明确的 where 和更新内容                       |
| deleteWhere         | 仅用于声明为 cleanup 的表；业务删除仍走生命周期协议 |

条件对象表示 AND，null 对应 IS NULL，显式 undefined 条件会被拒绝。复杂范围、排序、表达式和别名继续支持 Drizzle，例如 `fields: { label: conversations.title }` 返回 `{ label: string }`。

类型从表结构推导，不另写一套实体定义。条件字段、枚举、插入必填字段和返回投影都有提示；不能插入或修改绑定的归属字段。写操作返回驱动结果，不自动回读、自动 count、自动 upsert 或隐式重试。0 行更新的业务含义由调用方判断。

## ownerId 如何传递

```text
HTTP Cookie → Redis 会话中的 ownerId → 当前请求上下文
任务领取记录 → TaskLease.ownerId → 当前任务上下文
                                      ↓
                         database.companions.findOne(...)
                                      ↓
                     内部强制追加 owner_id = 当前 owner
```

IdentityContext 使用 Node AsyncLocalStorage 隔离异步执行链。HTTP 中间件先创建独立容器，鉴权守卫验证会话后填入身份；请求之间不会覆盖彼此。普通表对象是单例，对象不保存可变的当前 owner。

目前部署密码验证通过后，DeploymentIdentity 从持久默认空间取得 ownerId 并写入 Redis 会话。local 仅在这个单用户适配器中使用，普通 CRUD 不再查询默认用户。未来账号登录应把已验证账号绑定的 owner 写入会话；当前仍未开放多用户产品能力。

worker 每轮调度建立部署身份上下文，领取后使用持久记录里的 TaskLease.ownerId 建立任务上下文，心跳另建有界上下文。验证租约时再次检查归属。维护 CLI 和健康检查使用独立维护入口。

缺少身份时普通 CRUD 返回认证错误，不回退默认用户；客户端传入 owner 请求头不能切换身份。Redis 会话仍固定 12 小时过期，访问和进程重启不续期。

同一个执行上下文中的 `database.current()` 缓存结构检查和普通连接入口。它供需要复杂查询的 Repository 使用，普通 CRUD 无须先调用。结构维护前必须停止旧服务；长连接和任务的上下文应按有界业务步骤建立。

owner 限定不替代伴侣代次、成员、可见区间、删除限制和来源版本校验。直接 Drizzle SQL 不会自动改写，模块 Repository 必须明确限制所有关联记录的归属。

## 事务

```ts
await database.transaction(
  async (tx) => {
    const row = await tx.companions.findOne({
      where: { id: companionId },
      lock: 'update',
    });
    if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    await tx.companions.updateWhere({
      where: { id: companionId },
      set: { name: newName },
    });
  },
  { isolationLevel: 'read committed' },
);
```

正常返回提交，抛异常回滚，连接自动释放。返回错误对象仍属于正常返回；要撤销必须抛异常。事务操作必须 await，不能启动脱离回调生命周期的写入。

事务固定连接和 owner，按需缓存表操作对象，回调结束后拒绝继续使用旧 tx。事务中必须使用 tx 或显式接收 tx 的 Repository；普通 database 调用不会隐式加入事务，也不允许在 tx 上嵌套开启事务。

Drizzle 使用显式领取的 mysql2 连接执行回调。业务异常成功回滚后归还连接；begin/commit/rollback 异常导致状态不确定时丢弃连接，回滚失败保留最初异常。commit 网络错误可能意味着结果未知，不能自动重试或声称已经回滚。

配置、调度和会话锁顺序沿用现有协议。TaskStore.locked 等有领域含义的事务方法可继续使用回调；模型调用和外部网络等待不得持有业务事务。

## 代码入口

| 文件                                              | 职责                                   |
| ------------------------------------------------- | -------------------------------------- |
| database/identity-context.ts                      | 请求、任务的归属上下文                 |
| modules/auth/deployment-identity.ts               | 当前单用户部署的身份适配               |
| database/database.service.ts                      | 连接池、结构检查缓存、事务与表执行入口 |
| database/database-context.ts                      | 固定连接和归属，保护事务生命周期       |
| database/tables.ts                                | 集中声明表能力，首次使用才创建操作对象 |
| database/table-repository.ts、crud-types.ts       | 共用 CRUD 和字段推导                   |
| modules/companions/companion.repository.ts        | 伴侣列表与详情共用当前人格关联         |
| modules/companions/persona-template.repository.ts | 模板版本查询，复用单例，不反复 new     |
| http/api-exception.ts                             | 数据库异常与统一 HTTP 错误出口         |

复杂联表、幂等 upsert、领域锁和删除传播保留明确 SQL，不把所有业务规则塞进 CRUD 参数。两类常用关联查询已集中到 Repository，其他领域专用查询按实际复用需要整理。

## 开发库与表结构

消息片段已合入 messages.chatRunId/chatPosition，移除 chat_segments，保留同 owner/会话的外键和位置唯一约束。聊天读取省去片段补查，来源传播少一次关联，消息创建时同时写入轮次位置。当前共 41 张业务表，逐表结论和实验见 [表盘点](database-tables.md)。

开发阶段重建为 `0000_development_baseline`，不支持旧迁移链原地升级。生命周期只保留当前完整清理阶段；聊天只维护当前提示定义。工作区、消息、初始快照和人格文档里的固定 schemaVersion=1 标记已移除，前后端及验收脚本同步更新。

人格/记忆修订、原文内容版本、运行代次、乐观锁、任务租约及模型配置/编码标识仍有实际用途，继续保留。没有删除人格历史或更改来源可见性规则。

已有开发库更新时，在项目根目录执行：

```sh
# 先停止 pnpm dev 或 PM2 后端，保留 MySQL、Qdrant、Redis 运行。
pnpm install --frozen-lockfile
pnpm db:reset
pnpm dev
```

**db:reset 删除 `.env` 指向的开发库数据、这些 owner 的向量集合与头像，以及当前 Redis 命名空间的数据，再初始化新库。** 必须先停止所有共享此库的后端/worker；需要 MySQL 对目标库的 DROP/CREATE 权限。生产模式拒绝执行。其他库、其他 owner 的集合/头像和其他 Redis 命名空间不清理。跨服务清理不具有原子性，失败后保持服务停止并重试，不能认为已恢复原数据。

新安装仍执行 `pnpm db:migrate`。后续结构变更继续由迁移管理；本次重建基线不意味着取消迁移工具。旧 Cookie 失效，需要重新登录。数据库不可用时无法建立新的有归属会话，已有有效会话仍可查看系统诊断。

验证与交付结果见 [开发进度](../progress.md)。
