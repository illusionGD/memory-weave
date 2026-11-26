# F15 增量反思、自传与旧认识复核

反思读取已保存的真实结果。已完成活动、已采用的互动和纠正按来源版本登记。普通闲聊、未完成活动和初始化设定不登记为新经历。自传把实际经过与后来的理解分开，同时保留适用范围和不确定性。

## 调度与采用

- 使用模型配置中的 `reflection` 角色。常规检查默认间隔 24 小时，有意义的事件可提前触发，事件轮次默认相隔至少 1 小时，每个伴侣跨会话每天最多 2 轮。时间为 UTC，暂停、重启、换会话或重置代次不会重复获得配额。
- 只处理尚未安排的增量。轮次在派发前保存输入及依赖，恢复时继续使用同一请求身份。每项采用结论都要核对确切经历版本与实际片段，可分别标记支持和反例。观察候选独立保留，不能覆盖当前认识。
- 已确认的纠正在记忆提交事务内立即停用依赖旧版本的认识。后续复核按预算进行。来源删除时沿实际输入擦除正文和派生结果。
- 私聊按本轮消息检索少量有来源的当前认识。派发和发布之前复查其授权与有效性。已确定失效的旧认识不会再参与生成。
- 可用 `REFLECTION_CONFIG_JSON` 调整 `enabled`、`routineIntervalMs`、`minimumIntervalMs`、`dailyRuns` 与 `batchEvents`。真实和测试模型的经历、采用结果分别标记。

## 接口

- `POST /api/companions/:companionId/reflections/run` 接收 `runtimeEpoch`、`conversationId`，提前检查是否有可处理增量。返回任务身份或可查询的跳过状态。此入口也遵守轮次间隔和每日额度。
- `GET /api/companions/:companionId/reflections` 按会话和代次显示轮次状态、结论及已采用、观察和拒绝的数量。使用 `afterId` 与 `limit` 分页。
- `GET /api/companions/:companionId/reflections/findings` 使用同样的作用域和分页参数，查看认识、自传、观察状态及原始来源。通过 `GET /api/companions/:companionId/reflections/findings/:id/versions` 回查版本，使用 `beforeVersion` 与 `limit`。

## 升级与验证

已有库运行 `pnpm db:migrate` 应用增量迁移 `0005_reflections`。开启配置文件中的 `reflection` 任务即可执行真实模型反思，保持模板的定义版本。

`pnpm verify:f15` 使用隔离的 `TEST_DATABASE_URL` 和 `TEST_REDIS_URL`。验证安静时零调用、根据实际成果形成自传、拒绝伪造引文、相关私聊采用、即时停止旧认识、限额及来源删除。测试候选用于验证程序约束，真实模型的长期语义表现另做评估。
