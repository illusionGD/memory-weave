# 后端数据库访问

普通读写显式传 `ownerId`，事务显式传原生 Drizzle `tx`。DatabaseService 在启动时创建并复用表入口，不保存当前用户或当前事务。继续使用 Drizzle + mysql2，没有新增 ORM、依赖或表结构变更，**本轮无需 db:reset 或迁移**。

## 普通操作与类型

```ts
const companion = await database.companions.findById(ownerId, companionId);
await database.companions.update(ownerId, companionId, { name: newName });

const rows = await database.companions.findMany(ownerId, {
  where: { deletedAt: null },
  fields: ['id', 'name'],
  limit: 20,
});
// rows: { id: string; name: string }[]

const result = await database.companions.updateWhere(ownerId, {
  where: { id: companionId, version: expectedVersion },
  set: { name: newName, version: expectedVersion + 1 },
});
// affectedRows 用于判断原子更新是否成功，不先查再写。
```

| 方法                | 行为                                              |
| ------------------- | ------------------------------------------------- |
| findById / update   | 简化有 id 字段的表的主键读写，仍限定 ownerId      |
| findOne             | 查询一条，缺失返回 null；支持投影、排序和事务行锁 |
| findMany            | 必填正整数 limit，支持排序、投影和原有游标条件    |
| exists / count      | 在数据库侧判断或计数，不读取全部正文              |
| insert / insertMany | 自动附加传入的 ownerId，批量插入只发送一条 SQL    |
| updateWhere         | 必须有明确的 where 和修改内容，适合版本条件更新   |
| deleteWhere         | 仅允许 cleanup 表；业务删除继续走生命周期协议     |

条件对象表示 AND，null 对应 IS NULL；空写入条件、显式 undefined 条件及归属覆盖会被拒绝。复杂表达式继续用 Drizzle，不再封装另一套查询语言。别名投影例如 `fields: { label: conversations.title }` 返回 `{ label: string }`。

字段名、枚举、插入必填字段、更新类型和返回投影从 schema 推导，编辑器仍有提示，不重复定义实体。删除/追加能力、事务有效性和行锁要求由运行时检查，避免用多层条件泛型维护不同接口。写操作返回驱动结果，不自动回读、统计、重试或 upsert；0 行更新的业务含义由调用方判断。

## ownerId 的来源

```text
Cookie → Redis 会话 → AuthGuard 写入 request.ownerId
                            ↓
              控制器 @CurrentOwner() ownerId
                            ↓
              service.get(ownerId, id)
                            ↓
       database.companions.findById(ownerId, id)
```

请求体、查询参数或自定义请求头不能指定当前用户。缺少身份时表操作拒绝访问；表入口追加 `owner_id = ownerId`，没有默认用户回退，也没有 AsyncLocalStorage 或 `withOwner` 回调。

当前单用户部署在密码认证通过后，由 DeploymentIdentity 查出持久 ownerId 并写入 Redis 会话。`local` 只在这个身份适配器使用，CRUD 不查询它。未来多用户登录应把已验证账号的 ownerId 写入会话；当前尚未实现注册、账号管理或多用户调度。

worker 调度入口显式传入部署身份，领取后的执行和心跳使用可信 `TaskLease.ownerId`，提交时继续验证归属、租约和代次。Redis 会话仍固定 12 小时到期，访问和服务重启不续期。

owner 限定不替代成员、来源可见性、运行代次和生命周期校验。原生 SQL 不会自动追加 owner 条件，模块 Repository 必须明确限制关联记录的归属。

## 事务与复杂查询

```ts
await database.transaction(
  async (tx) => {
    const row = await database.companions.findOne(
      ownerId,
      { where: { id: companionId }, lock: 'update' },
      tx,
    );
    if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    await database.companions.update(ownerId, companionId, { name: newName }, tx);
  },
  { isolationLevel: 'read committed' },
);
```

事务回调拿到原生 Drizzle 连接。基础操作把 tx 放在最后一个参数；复杂查询直接用 `tx.select(...)`。普通复杂查询用 `database.sql.select(...)`。没有 `tx.表`、`tx.sql`、bind/connect 或每次调用创建的表代理。

回调正常返回提交，抛异常回滚，连接自动释放。返回错误对象仍属于正常返回；要撤销必须抛异常。事务操作必须 await。忘记传 tx 会使用普通连接，不会隐式加入事务；Repository 拒绝已经结束或不属于当前 DatabaseService 的事务。原生连接不包装代理，调用方不得在回调结束后继续使用它或嵌套创建事务。

begin/commit/rollback 出错导致连接状态不确定时丢弃连接，回滚失败保留原业务异常。commit 网络错误可能意味着结果未知，不自动重试。模型和其他外部网络等待仍在事务外执行。

基础 CRUD 直接执行 Drizzle；模块 Repository 只收拢实际复用的查询，例如伴侣与人格、模板与版本的关联。联表、聚合、幂等 upsert、锁顺序以及生命周期对历史正文的擦除保留明确 SQL；不为统一外观而改变查询范围或历史追加限制。

## Review 入口

| 文件                                              | 职责                                       |
| ------------------------------------------------- | ------------------------------------------ |
| modules/auth/current-owner.ts、auth.guard.ts      | 从已认证请求中显式取身份                   |
| modules/auth/deployment-identity.ts               | 当前单用户登录和调度的身份适配             |
| database/database.service.ts                      | 连接池、事务、结构状态和启动时创建的表入口 |
| database/table-repository.ts                      | 常用操作、字段推导和运行时约束             |
| modules/companions/companion.repository.ts        | 伴侣与当前人格的常用关联查询               |
| modules/companions/persona-template.repository.ts | 模板与版本的常用关联查询                   |
| modules/tasks/task-worker.service.ts              | 调度、租约执行与心跳显式传身份             |
| http/api-exception.ts                             | 统一数据库错误分类                         |

原 IdentityContext、DatabaseContext、DatabaseTables、crud-types 已删除。减少简单回调的嵌套、使用主键快捷操作和对象属性简写；保留必要类型和领域校验，避免为少写几个字符增加新抽象。

## 较早开发库的结构升级

消息片段已合入 messages.chatRunId/chatPosition，移除 chat_segments，保留同 owner/会话的外键和位置唯一约束。聊天读取省去片段补查，来源传播少一次关联，消息创建时同时写入轮次位置。当前共 41 张业务表，逐表结论和实验见 [表盘点](database-tables.md)。

开发阶段重建为 `0000_development_baseline`，不支持旧迁移链原地升级。生命周期只保留当前完整清理阶段；聊天只维护当前提示定义。工作区、消息、初始快照和人格文档里的固定 schemaVersion=1 标记已移除，前后端及验收脚本同步更新。

人格/记忆修订、原文内容版本、运行代次、乐观锁、任务租约及模型配置/编码标识仍有实际用途，继续保留。没有删除人格历史或更改来源可见性规则。

只有尚未升级到 `0000_development_baseline` 的旧开发库需要重建；已经在该基线上的开发库，本轮无需重建。旧库升级在项目根目录执行：

```sh
# 先停止 pnpm dev 或 PM2 后端，保留 MySQL、Qdrant、Redis 运行。
pnpm install --frozen-lockfile
pnpm db:reset
pnpm dev
```

**db:reset 删除 `.env` 指向的开发库数据、这些 owner 的向量集合与头像，以及当前 Redis 命名空间的数据，再初始化新库。** 必须先停止所有共享此库的后端/worker；需要 MySQL 对目标库的 DROP/CREATE 权限。生产模式拒绝执行。其他库、其他 owner 的集合/头像和其他 Redis 命名空间不清理。跨服务清理不具有原子性，失败后保持服务停止并重试，不能认为已恢复原数据。

数据库维护命令直接读取 contracts 源码，无须预先 build，也不受旧 dist 影响。新安装仍执行 `pnpm db:migrate`。后续结构变更继续由迁移管理；本次重建基线不意味着取消迁移工具。旧 Cookie 失效，需要重新登录。数据库不可用时无法建立新的有归属会话，已有有效会话仍可查看系统诊断。

验证与交付结果见 [开发进度](../progress.md)。
