# F13 委托活动与成果

用户可为当前会话中的伴侣创建写作和文字阅读委托。目标、执行、作品版本和用户确认均保存在 MySQL。聊天照常进行，普通消息不会创建活动，也不会改变已有委托的目标。

## 命令与查询

- 登录后调用 `POST /api/activities`。正文包含 `companionId`、`runtimeEpoch`、`conversationId`、UUID `requestId` 和 `specification`。同一请求可按原参数重试。
- 写作的 `specification` 使用 `{ kind: "write", goal }`，可指定 `source: { messageId, contentVersion }` 作为参考。保存提纲后才撰写正文。
- 阅读的 `specification` 使用 `{ kind: "read", goal, source: { materialId, messageId, contentVersion }, range: { from, through } }`。范围包含两端，每次最多八个连续位置，每个文字位置保留最多 240 字符，并报告截断或未读图像。全文分批仍由 F11 提供。
- 两类活动都可在 `specification` 中加 `dependsOnActionId`。动作必须属于同一会话和实例代次。设备离线、动作已经发出或结果未知时，系统等待该动作的确切回执。失效、失败或确定未执行会保留受控阻塞原因。活动本身不补发设备命令。
- `GET /api/activities` 使用上述三个作用域参数分页。用 `GET /api/activities/:id` 查询当前版本，用 `GET /api/activities/:id/versions` 或 `GET /api/activities/:id/versions/:version` 查询历史。历史分页使用 `beforeVersion` 与 `limit`。
- 通过 `POST /api/activities/:id/revisions` 提交新的 UUID `requestId`、`expectedVersion` 和 `specification`。目标替换与撤销旧写回资格在同一个事务提交。未完成版本不会被旧生成结果覆盖，已完成作品保留在历史中。
- 使用返回的 `task.id` 调用 F04 的暂停、恢复或取消接口。步骤只有在提纲、材料范围或成果实际落库后才改变。已保存的模型调用使用同一身份恢复，未知模型结果保留待核对。
- `delivery: "available"` 表示可取回实际成果。只有客户端调用 `POST /api/activities/:id/versions/:version/acknowledge` 才记录已确认交付。完成不会自动生成聊天消息或外部通知。作品标注真实模型或确定性测试模型。

## 升级与验证

已有库执行 `pnpm db:migrate` 应用增量迁移 `0003_activities`。活动保存确切会话来源。删除其来源、相关终端动作来源或清理旧实例代次时擦除关联文本、检查点和成果。

`pnpm verify:f13` 使用 `TEST_DATABASE_URL` 与 `TEST_REDIS_URL` 指向隔离测试服务。用例通过公开 HTTP 验证重启、暂停与恢复、迟到结果、阅读片段覆盖和删除、终端回执等待及交付确认。写作和阅读沿用模型配置的聊天角色，消费后台预算。
