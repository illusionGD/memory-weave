---
name: data-foundation
description: 维护 F02 实例、人格版本、共享会话、原文来源、独立读取和数据库迁移基础。
---

# F02 数据基础

先读 [功能说明](../../../docs/features/f02-data-foundation.md)、[架构](../../../docs/architecture.md) 和 [进度](../../../docs/progress.md)。遵循 coding、tdd 和现有 frontend/server 约束。

## 入口与边界

- `apps/server/src/database` 与 `drizzle-mysql`：类型化结构、持久 owner、维护 CLI、迁移历史。
- `modules/companions`：实例身份、独立初始快照/当前人格与 UUID 分页。
- `modules/workspace`：当前用户资料，显示名称可改，持久 owner 和历史身份关联不变。
- `modules/conversations`：共享会话、消息保存/发布、来源与每实例接收。
- `packages/contracts`：严格输入和稳定响应，字段中文 JSDoc 随声明文件导出。
- `scripts/verify-f02.mjs`：使用 HTTP 创建验收数据；明确告知永久写入，不清空已有数据。

所有领域查询限制当前 owner。管理者可管理所属实例；伴侣视角查询还必须校验当前代次、成员及可见区间。不能把管理者能力当成伴侣获得其他私聊的授权。

HTTP 响应统一为 `{ code, data, message }`，数字常用码通过 contracts 的 `API_CODES` 引用；`ApiException` 也允许业务自定义码和文案。不存在与不可见均用 `RESOURCE_NOT_FOUND`；幂等、版本、代次和权限冲突分别分类，不能依赖提示文字。领域 schema 仅描述 data；HTTP 验收脚本复用公共外层校验。HTTP 追踪编号不替代创建/发布/接收命令的幂等键，详见 [公共 API 约定](../../../docs/api-conventions.md)。

显示名称属于 owner 资料，不是登录凭据，也不代替每个伴侣自己的关系称呼。默认“用户”，首尾去空白后为 1～80 字符；修改不得更换 ownerId 或改写历史消息。个人设置页面对名称使用纯文本渲染，沿用真实 API 和权限判断。

共享原文只保存一份。初始快照、当前人格、原文、读取记录和待整理区间分别保存；普通查询无已读副作用。显式接收只表示取得正文，不能当作模型理解、提取成功或终端交付。接收幂等批次必须固定确切消息集合，重试重新核对当前权限。

保存草稿与发布分别幂等。发布锁定会话并校验预期版本/代次，原子分配序号并登记各可见伴侣的待整理范围。保留逐消息范围，禁止用单一最大游标跳过遗漏。来源必须匹配确切版本且可见；本轮只开放同会话来源。

## 迁移与验证

当前持久库是 MySQL 8.4.9，向量服务是 Qdrant 1.18.3。按用户明确要求不迁移开发阶段 PostgreSQL 数据；旧 drizzle 文件留档，新迁移只读 drizzle-mysql。已交付 MySQL SQL/journal 不可改写，新增结构生成新迁移并保留 LF。维护连接用数据库范围的 GET_LOCK 串行执行并校验历史前缀/hash；DDL 执行前持久写 applying、全部完成后写 applied，失败后拒绝重试和就绪，不能宣称事务回滚。领域事务使用 READ COMMITTED 与会话行锁；重复键不能覆盖已有业务内容。CLI 只依赖 MySQL；HTTP 启动和健康检查不能自动执行 DDL。更新结构后核对生产包含 SQL、Compose 先迁移后启动，以及已有 MySQL 卷的重启持久化。

用户于 2026-10-27 明确允许清理旧开发数据和重建开发库；必要的清理可在已确认的项目开发环境内直接执行，无须重复确认。

真实测试必须显式提供独立 MySQL 的 `TEST_DATABASE_URL`、`TEST_QDRANT_URL` 与 `TEST_QDRANT_API_KEY`，使用 `test/support/database.ts` 创建并仅清理自己的临时数据库。领域测试经 HTTP 观察行为；迁移测试经维护命令验证。不可在未运行数据库用例时宣称通过。按已确认 seam 逐行为红绿验证，无需重新请求用户确认。

完成后运行相关格式、lint、类型、真实 HTTP/迁移、构建、浏览器和部署检查。更新功能说明/进度，删除临时任务计划；在已授权的 dev 分支提交推送，交付固定 SHA 和比较基线，停在本功能供 review。
