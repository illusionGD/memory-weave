# F19 自主探索、活动与联系

用户可为具体伴侣代次选定一个私聊并启用自主工作。每次机会可能保持安静、建立实际写作任务，或形成联系意向。成果沿用活动执行、版本、检查点和交付协议，是否完成以已保存的实际结果为准。

## 权限与查询

- `PUT /api/companions/:id/autonomy` 接收 `conversationId`、`runtimeEpoch`、`expectedVersion`、UUID `requestId`、`enabled` 和 `contactsEnabled`。首次版本用 0。许可限定当前私聊和代次，可单独开启主动联系。
- `GET /api/companions/:id/autonomy?runtimeEpoch=1` 查询许可。用 `GET /api/companions/:id/autonomy/opportunities?runtimeEpoch=1` 查询实际机会、决定、活动与联系身份。自主创建的活动带 `origin: "companion"`。
- `GET /api/autonomy/contacts` 查询待发送、过期、实际发布和确认状态。已发布的话在原私聊中出现。客户端通过 `POST /api/autonomy/contacts/:id/acknowledge` 确认实际交付，首次确认时间固定保留。

## 调度与额度

- `AUTONOMY_CONFIG_JSON` 可配置时区、探索频率和额度、模型生成额度、联系频率和静默时间。初始值为每实例每 6 小时最多一次探索、每日 4 次机会、每日 12 次自主生成。测试与正式场景沿用部署中的模型角色与费用限制。
- 自主写作的提纲和作品分别推进。超出自主预算时保留检查点供下一窗口继续，用户直接委托继续使用独立的工作额度。重启保留机会、调用计量、授权和已发联系。
- 普通联系按用户跨实例合计，每日最多 2 次、至少相隔 4 小时。未获得关联回复时需等待 24 小时，默认静默为当地 23:00 至次日 09:00。将同一个联系认定为已交付不会增加额度。发送前再次核对授权、对话和依据，新交流可结束旧意向。
- 探索使用配置中的 `reflection` 角色，自主作品使用 `chat` 角色。确定性测试输出保留测试标记。

## 升级与验证

已有库应用增量迁移 `0009_autonomy`。既有活动仍以用户委托为来源。未配置自主授权的伴侣继续等待用户输入。

`pnpm verify:f19` 在隔离的 MySQL 与 Redis 中验证无授权和安静机会、实际完成写作、自主与委托预算分离、跨实例额度、应用重启、许可撤销与真实发布确认。
