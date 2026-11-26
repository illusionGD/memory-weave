# F14 感受与定向关系

每个伴侣在自己的会话范围内维护认识。自身短期感受、对方最近表达、双方各自倾向、共同约定及未解分歧分别记录。即使引用同一段群聊，A 对 B 的认识和 B 对 A 的认识也有独立版本。

## 更新与有效范围

- 已采用的记忆批次含感受、互动、倾向或约定线索时，才安排后台关系任务。任务复用模型配置中的 `relationship` 角色、后台额度和持久租约。普通闲聊和空结果不增记关系。
- 模型依据授权范围内的实际交流提议状态。应用核对逐字引文、版本、语境和发话者。单方倾向只归属于其表达者。共同约定至少需要双方各自的实际陈述。推断保留不确定性标记。
- 同一方向和主题按实际原文顺序提交版本。重复读取旧原文不会刷新时间，也没有好感分。自身感受默认有效 48 小时，对方近期表达默认有效 6 小时。可通过 `RELATIONSHIP_CONFIG_JSON` 的 `selfEmotionTtlMs` 和 `observedEmotionTtlMs` 调整。过期从当前视图撤下，合法历史仍可回查。
- 私聊模型可获得当前用户相关且仍有效的状态快照。新消息仍直接参与回复。状态及采用它的回复均保留实际原文引用。来源删除或实例清理后，受影响状态会擦除，旧状态不会自动恢复为当前认识。

## 查询

- `GET /api/companions/:companionId/relationships` 要求明确的 `runtimeEpoch` 与 `conversationId`，可按 `counterpartMembershipId` 筛选。使用 `afterId` 和 `limit` 分页。
- `GET /api/companions/:companionId/relationships/:id/versions` 回查版本。使用 `beforeVersion` 和 `limit` 分页。结果包含认识类型、来源身份、可见状态、实际时间、推断性质和测试模式标记。

## 升级与验证

已有库执行 `pnpm db:migrate` 应用增量迁移 `0004_relationships`。在模型配置文件中按需开启 `relationship`，保留模板中的提示、Schema 与预处理版本。实际语义效果需要用选择的模型评估。

`pnpm verify:f14` 使用隔离的 `TEST_DATABASE_URL` 和 `TEST_REDIS_URL`。验证无需语义的空批次、双方方向、精确引文、单方请求、短期状态失效、聊天采用与来源删除。
