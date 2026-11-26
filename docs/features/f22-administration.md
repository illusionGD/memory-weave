# F22 后台管理接口

管理接口沿用当前部署账号的认证与访问范围。`GET /api/management/configuration` 汇总部署配置、默认值、有效值、来源、版本及实际更新入口。模型或任务组的配置更新继续通过各自的版本接口，实例覆盖仍由成长、自治和会话模块保存。

- `GET /api/management/model-calls` 可按角色、状态、会话、伴侣和代次查询。用量汇总来自实际尝试账本。尝试详情原样沿用 `GET /api/models/calls/:id`。
- `GET /api/management/chats/:id/runs/:runId` 回查现有生命周期许可下的确切轮次、采用的来源和任务。群响应继续通过 F18 逐人查询。
- `GET /api/management/conversations/:id/messages/:messageId` 分开查看正式发布、当前可见性、每个实例实际取得的 UTF-16 字符范围、整理进度和真实终端确认。确认送达的含义为终端已取得消息。
- `GET /api/management/lifecycle/:id` 返回明确选择、已发现派生消息和现有清理进度。重置、删除、继续清理分别沿用生命周期命令。成长候选、冻结和回退继续使用 F16 的版本入口。
- `GET` 和 `PUT /api/management/companions/:id/memories/:memoryId/pin` 读取或修改固定状态。`PUT` 需要 `requestId`、`runtimeEpoch`、`expectedMemoryVersion`、`expectedPinVersion` 和 `pinned`。固定后的当前记录受到归档保护，后续委托更正和来源清理仍以现有版本为准。

先用 `pnpm db:migrate` 应用 `0012_memory_pins`。在独立 MySQL 和 Redis 上运行 `pnpm verify:f22` 验证认证、采用来源、实际读取和交付、删除范围。固定和归档联动由 `pnpm verify:f21` 的旧经历场景验证。
