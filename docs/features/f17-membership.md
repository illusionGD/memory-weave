# F17 会话成员和历史授权

会话支持用户与伴侣私聊、伴侣间私聊，以及可包含用户的群聊。邀请保存为待决记录，接受后才加入。扩展双人私聊时新建群聊，原私聊成员与授权范围继续保留。

## 邀请、退出与管理

所有路径均以 `/api/conversations/:conversationId` 为前缀。

- 使用 `POST /invitations` 提交 UUID `requestId`、`expectedConversationVersion`、目标 `companionId` 和 `runtimeEpoch`。可为新群指定 `groupTitle`。用 `GET /invitations` 分页查看状态。
- 使用 `POST /invitations/:id/decision` 及 `requestId`、`expectedVersion`、`decision` 执行 `accept`、`decline`、`defer` 或 `cancel`。记录实际作决定的身份类型。默认有效期为 24 小时，暂缓不延长期限。
- 使用 `POST /members/:id/exit` 提交 `requestId`、`expectedConversationVersion` 和 `expectedPermissionVersion`，离开当前用户的成员身份或移除伴侣。离开后的新消息不可取得。被移除后再次邀请需管理账号填写 `restoreRemoved: true`。
- 重新加入会开启新的发布区间，保留以前仍有效的区间。离开至再次加入之间的消息须另行授权。
- 使用 `POST /membership-policy` 提交 `requestId`、`expectedConversationVersion` 和 `peerInvitationsEnabled`。同伴邀请在发出和接受时都核对设置。
- 使用 `POST /close` 提交 `requestId` 与 `expectedConversationVersion` 结束会话。已经发布的历史仍按授权可查。

## 历史及背景

- 使用 `POST /history-requests` 提交 `requestId`、群成员 `membershipId`、`expectedPermissionVersion` 和闭区间 `range: { from, through }`。每项请求最多包含 100 个旧序号。
- 使用 `POST /history-requests/:id/decision` 提交 `requestId`、`expectedVersion`、`decision`，可 `approve`、`reject` 或 `revoke`。批准只为新开放的消息补登记待整理范围。重复授权不重复整理，撤销不影响其他仍有效的独立范围。审批进度通过 `GET /history-requests` 查询。
- 使用 `POST /background` 可发布已获访问许可的精确跨会话片段。提交 `requestId`、目标 `expectedConversationVersion`、`sourceConversationId`、`messageId`、`contentVersion`、`startOffset` 与 `endOffset`。偏移为 UTF-16，最多 1200 个单位，引用实际原文与已知发生时间。群成员取得明确发布的片段，原文继续受原会话权限约束。删除原文会随生命周期清除派生片段。
- 校验伴侣具体视角可用 `GET /api/companions/:companionId/conversations/:conversationId/messages?runtimeEpoch=1`。管理查询与伴侣可视范围分别使用各自接口。

## 升级与验收

已有库应用迁移 `0007_membership`。旧库已有的历史可见范围转为保留范围，加入前没有授权的序号继续不可见。

`pnpm verify:f17` 使用隔离的 `TEST_DATABASE_URL` 与 `TEST_REDIS_URL`。验证邀请与暂缓、加入边界、历史补处理、授权撤销、移除和重新加入、私聊扩展、精确背景和删除传播、空会话退出以及结束后继续读取历史。
