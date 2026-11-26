# F16 自主人格成长

有足够独立经历的反思可安排成长任务。任务首先提出一项局部 L1 倾向变化，再使用独立的模型请求复查当前人格、锁定项、原始记录、实际成果和反例。只有两次结果与程序校验同时允许，才追加当前人格版本。

- 成长优先保持已有的名字、核心、知识、初始设定及长期约束。模型只可提出一项有适用情境的局部兴趣、审美、表达、思考或观点。证据不足保留观察结果。
- 使用配置中的 `growth` 和 `growth_validation` 两个角色，分别消耗后台容量和预算。默认同一伴侣至少隔 24 小时才可再次自动采用；通过 `GROWTH_CONFIG_JSON` 的 `enabled` 和 `minimumAdoptionIntervalMs` 调整。回退、重启和重置保留已消耗的节奏记录。
- 冻结操作立即撤销先前候选的采用资格。旧请求可能已有调用用量，结果无法提交到新的人格或控制版本。
- 同代次回退只恢复可用的 L1 成长内容，追加一个新版本并保留当前名字、核心和约束。不可回退到另一个运行代次，也不能重新采用来源失效的成长。
- 当前私聊读经验证仍可使用的成长视图。确认纠正后先停止使用受影响倾向。清理原文时擦除相应候选、验证正文和历史版本中的派生倾向。

## 查询和管理

- `GET /api/companions/:companionId/growth/control?runtimeEpoch=1` 查询冻结控制，初始版本为 0。
- `POST /api/companions/:companionId/growth/freeze` 接收 `runtimeEpoch`、`expectedVersion`、UUID `requestId` 和 `frozen`，用于冻结或解冻。
- `GET /api/companions/:companionId/growth/candidates` 按 `runtimeEpoch` 查询实际提案、验证、状态和采用版本。使用 `afterId` 与 `limit` 分页。
- `GET /api/companions/:companionId/growth/versions` 按 `runtimeEpoch` 查人格版本，使用 `beforeVersion` 与 `limit` 分页。
- `POST /api/companions/:companionId/growth/rollback` 接收 `runtimeEpoch`、`expectedPersonaVersionId`、`targetPersonaVersionId` 和 UUID `requestId`，进行带预期版本的同代次回退。

## 升级与验证

已有库应用增量迁移 `0006_growth`。已保存的基础人格保留原样，首次成长时追加 L1 内容。真实模型部署按需启用两个成长角色并保留模板所列定义版本。

`pnpm verify:f16` 使用隔离的 `TEST_DATABASE_URL` 和 `TEST_REDIS_URL`。验证两次独立模型调用、保护锁定项、自动提交、冻结拒绝迟到结果、来源删除和跨代次回退边界。真实模型的语义一致性与长期变化仍按后续发布评估。
