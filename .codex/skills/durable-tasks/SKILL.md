---
name: durable-tasks
description: 维护 F04 MySQL 持久任务、outbox、租约、恢复和调度配置。
---

# F04 持久任务

先读 [功能说明](../../../docs/features/f04-durable-tasks.md)、架构 §13.4/13.5、plan/progress 及 coding/tdd/data-foundation/model-runtime。沿用已确认的 HTTP、任务控制/状态、模型 adapter 和进程恢复测试边界，不重复请求用户确认。

- 主库保存任务、精确检查点、每次尝试、配置版本和 outbox；进程内定时器仅唤醒。Redis 不能成为权威记录。
- 发布消息、逐实例 pending 范围和 outbox 同事务；转交任务及 outbox dispatched 同事务。dispatched 只表示任务登记，不能标记记忆、读取或终端交付成功。F08 未实现前 memory_extraction 保持 handler_unavailable，空轮询不调用模型。
- 去重身份包含实例、运行代次、消息版本和阶段；不得以 A 完成代替 B，也不能用最大序号越过未完成区间。
- TaskStore 在短事务内锁定部署专用调度行；不得持锁访问模型、文件或工具。租约依据数据库时间，心跳不能复活过期代号或越过本次绝对截止时间。
- 每次领取保存新令牌、递增代号和配置快照。检查点、结果提交必须验证租约、取消及来源/权限/代次；领域回调负责自己的状态版本和精确进度。complete 回调、结果与后续 outbox 同事务，抛错全部回滚，重放不再执行回调。领域回调结束后必须再次读取数据库时间验证租约，不能使用事务开始时间放行迟到结果。
- 调度参数唯一默认值在 task-configuration.service.ts，类型、单位与边界在 contracts/tasks.ts；配置只追加版本。新派发用新版本，在途心跳保持原租约快照，重启/配置更新不清零尝试或模型用量。
- 模型任务保持稳定调用 requestId，复用 F03 background 容量。ModelDispatchGuard 在模型派发事务内检查任务；先模型配置锁、后任务调度锁，禁止任务事务反向调用模型事务。取消先落盘任务，再取消模型。
- 已保存模型结果恢复复用，running 只查询原调用，unknown 转 blocked，不自动换键补发。可信迟到用量仍结算。工具核对能力未接入前不得宣称外部动作恰好一次。
- worker 由 main 在监听后启动；createApplication 不自动消费。关闭先等待 worker 有界执行，再关闭连接池；SIGKILL 情况靠持久租约接管，不能依赖退出回调保存工作。
- 管理 API 只提供诊断、状态、配置与暂停/恢复/取消，不导出租约令牌或任务输入。队列模型诊断为恢复而保存输入，不写真实经历；HTTP 统一数字 code/data/message。
- 0002 已包含 F02/F03 旧 pending 范围回填，交付后不可改写 SQL/journal/hash；后续结构只追加迁移。维护命令、DDL 失败与历史校验仍沿用 data-foundation。
- 修改后跑真实隔离 MySQL、HTTP/公开 worker 协议、本地供应商、必要的子进程强杀测试；不以直接读写内部表代替公开行为。新增领域处理器必须补入版本/失效与重复提交测试。
- 验收脚本 verify:f04 仅创建两条诊断并调用一次 test，不改用户配置、不执行付费模型；不要为验收强行改真实配置。

完成后同步功能说明、README、plan/progress 与技能，执行格式/lint/typecheck、完整相关测试、构建、必要浏览器和 Docker 升级/保留卷恢复验证。按已有授权在 dev 追加提交并推送，交付 SHA、比较基线和启动验收步骤；停在本功能供 review，不自行进入 F05。
