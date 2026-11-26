# F18 多参与者顺序接话

群聊每次只有一个有效的接话轮次。系统逐人固定可见原文、当前人格和成员权限，下一位可以看到前一位已正式发布的消息。发言、静默、失效和等待分别保存。

## 接口

- 用 `POST /api/conversations/:conversationId/turns` 发送消息并建立轮次。请求包含 `requestId`、`expectedConversationVersion`、`text` 和 `addressing`。
- `addressing: { mode: "mention", membershipId }` 指定一位伴侣回应。`{ mode: "each", membershipIds }` 按实际列表顺序给予机会。`{ mode: "any" }` 依先前发言选择一位，并让另一位判断是否有补充。
- 用 `GET /api/conversations/:conversationId/turns` 查询轮次列表，或用 `GET /api/conversations/:conversationId/turns/:id` 查询单个轮次及每位伴侣的状态。历史读取没有安排新发言的副作用。
- 用 `POST /api/conversations/:conversationId/turns/:id/stop` 和 UUID `requestId` 停止当前轮次。如果通过群聊轮次或通用发布接口发出新的用户消息，已有轮次尚未发布的结果失去资格。此前已经发布的内容保留。
- 接话沿用配置的 `chat` 模型角色，结果使用结构化发言或静默。每一步先固定模型输入和调用身份，再在同一提交中写入正式消息及检查点。实例重置、退出、权限变化及来源失效会阻止该参与者继续发布。

## 升级与验证

已有库应用增量迁移 `0008_group_turns`。原有私聊仍走相同聊天接口。

`pnpm verify:f18` 使用隔离的 `TEST_DATABASE_URL` 与 `TEST_REDIS_URL`。验证各人独立人格与历史、新成员读取范围、逐人发布顺序、静默、普通消息插话、迟到阻断和点名后续回复。
