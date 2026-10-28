# F04 持久任务、outbox 与恢复

比较基线：`c8c0d9e`。本轮让任务在进程退出后仍可查询、接管和继续，并将消息发布与后续待办原子保存。任务管理使用 HTTP 和 CLI；完整管理页面按 F22 实现。当前可执行确定性步骤诊断和后台模型诊断，记忆提取按 F08 实现。

## 升级和验收

保持已有 MySQL、Qdrant 和部署密码，先停止旧应用，在项目根目录执行：

```powershell
git pull --ff-only origin dev
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev
```

另开项目终端：

```powershell
pnpm verify:f04
pnpm tasks:config list
pnpm tasks:config outbox
pnpm tasks:config show
```

F04 验收通过真实 HTTP 检查 11 项行为，保存两条隔离诊断任务，其中一条调用确定性 test 模型。运行期间避免其他模型调用，否则用量增量断言会受影响。脚本不改配置，只允许 chat 使用 test；没有真实模型密钥也可运行。任务 ID 会打印出来，超时后用 `pnpm tasks:config get <ID>` 查询，不直接创建替代任务。完成记录会保留；脚本不会清空用户数据。

Docker 整套部署：

```powershell
docker compose --env-file .env -f deploy/compose.yaml up -d --build --wait
$env:VERIFY_BASE_URL = 'http://localhost:8080'
pnpm verify:f04
Remove-Item Env:VERIFY_BASE_URL
```

本轮不需要新容器或 Redis。生产 app 启动 HTTP 监听后自动启动 worker；迁移仍由已有 migrate 服务先执行，HTTP 启动不自动执行 DDL。Node 开发/生产启动也自动运行 worker。`createApplication` 本身不启动消费，便于维护工具及故障测试分别控制 HTTP 和 worker。

新增迁移 `0002_durable_tasks`，保留已交付的 0000/0001 原文与 hash。新增任务、尝试、调度配置、调度锁行和 outbox 五张表；同时从 F02/F03 逐实例待整理范围补登记 outbox。已有身份、人格、原文、读取状态和模型用量不改写。已发布消息在升级后也会成为可追溯的待处理任务。

## 状态与恢复规则

| 状态      | 含义                                                   |
| --------- | ------------------------------------------------------ |
| queued    | 已保存，等待领取                                       |
| running   | 持有有效租约，正在执行当前步骤                         |
| waiting   | 可恢复失败或租约过期，已安排有界退避                   |
| paused    | 管理者暂停，保留检查点                                 |
| blocked   | 处理器未提供、来源失效或外部结果未知，需要对应模块核对 |
| succeeded | 本任务的结果提交已完成，不代表向用户交付或其他伴侣完成 |
| failed    | 明确失败或累计尝试上限已到，保留原因与历史             |
| cancelled | 已取消后续提交，不宣称撤销外部效果                     |

调度使用 MySQL 短事务与每部署独立锁行，原子核对当前配置和运行数量后领取。模型调用、等待和工具访问不能持有数据库事务。当前上限小、部署为模块化单体，串行化短调度决策便于核对容量和版本；没有做高吞吐量承诺。将来确有吞吐需要时再评估分区、SKIP LOCKED 或 Redis 队列，主库幂等和 outbox 仍保留。

每次领取保存递增代号、随机令牌、完整配置快照和绝对截止时间。心跳只在租约有效时续期，不能越过此次绝对截止时间；数据库时间作为判断依据。过期接管保留已经保存的检查点，旧代号、过期令牌、暂停或取消后的提交全部拒绝。旧 worker 仍可能收到外部返回，但不能恢复已失效的任务。完成提交在领域回调结束后再次读取数据库时间和有效范围；异常缓慢的回调跨越租约时整笔回滚。完成提交重放不会再次执行领域回调。

暂时错误采用有上限的指数退避，配置更新和重启都不清零累计次数。配置降低到已有运行量以下时阻止新领取，已发出的操作继续核对。空队列与没有处理器的任务不会为“检查是否有事”调用模型。

后台模型诊断复用 F03：固定持久调用身份，使用 background 容量，继续检查模型配置、每日额度和部署硬上限。派发事务中还检查任务租约及调度开关。恢复时，已有成功结果直接复用；已发出但尚未结束的调用只查询原身份；过期成为 unknown 后任务转入 blocked，不自动换 requestId 补发。取消任务会先落盘，再取消已关联模型调用；可信迟到用量仍结算，未知用量仍占用预留。

进度只显示实际保存的步骤数。模型结果保存、任务提交、原文发布、每实例提取和用户交付是不同状态，不能以某个任务的 succeeded 替代后续业务已生效。

## 消息与独立实例

正式发布消息时，同一事务完成：序号分配、原文发布、每个可见伴侣的逐消息待整理范围，以及一条 outbox。草稿或失败发布不进入 outbox；幂等重放不新增待办。

worker 在另一个短事务中，将 outbox 转交为每个接收实例自己的 `memory_extraction` 任务，身份包含实例、运行代次、消息版本和阶段，并一起标记 outbox 已转交。转交前核对来源版本、实例代次、成员权限和可见区间。消息正文仍只保存一份，任务只保存引用。

当前没有记忆提取处理器，这些任务显示 `blocked / handler_unavailable`，已有待整理范围保持 pending，不调用模型、不形成记忆、不推进读取或整理游标。F08 将把连续消息组合为合适批次，并逐个实例原子提交正文结果、确切处理范围与索引 outbox；不能简单逐条触发模型，也不能使用最大序号跳过未完成区间。Qdrant 索引同步由 F09 接入。

## 集中调度配置

配置按部署整体发布，不提供实例覆盖；完整版本保存在 MySQL，历史不可覆盖，回滚也发布新版本。普通调度配置不会改动模型硬上限或工具授权。

| 字段             | 单位 / 默认   | 可调范围                                      |
| ---------------- | ------------- | --------------------------------------------- |
| enabled          | 布尔 / true   | 只控制新派发，关闭不撤销已经发出的操作        |
| maxConcurrent    | 个 / 1        | 1～4；4 为当前实现上限，模型仍受 F03 后台限制 |
| pollMs           | 毫秒 / 1000   | 100～30000                                    |
| leaseMs          | 毫秒 / 30000  | 1000～300000；心跳间隔为三分之一              |
| attemptTimeoutMs | 毫秒 / 180000 | 1000～600000，必须不小于租约                  |
| maxAttempts      | 次 / 3        | 1～10，暂停后恢复也算新领取                   |
| retryBaseMs      | 毫秒 / 1000   | 100～60000                                    |
| retryMaxMs       | 毫秒 / 60000  | 100～3600000，不小于退避起点                  |
| outboxBatchSize  | 条 / 20       | 1～100                                        |

```powershell
pnpm tasks:config export
# 编辑 task-config.local.json，保留 requestId 和 expectedVersion
pnpm tasks:config apply
```

默认本地文件已忽略，导出不覆盖已有文件。自定义文件路径需自行避免提交。配置带版本和 default/deployment 来源；同命令重放不新增版本，过期修改返回冲突。新调度使用新配置；在途心跳使用本次领取的租约与截止快照，下一次恢复再使用新配置。调度重试次数与模型请求次数分别计量，两者都保留历史。

单个任务控制：

```powershell
pnpm tasks:config get <任务ID>
pnpm tasks:config pause <任务ID>
pnpm tasks:config resume <任务ID>
pnpm tasks:config cancel <任务ID>
```

日常执行无需逐条确认。暂停/取消是管理者明确发出的控制命令；取消不可恢复，已完成任务的取消是无副作用重放。达到尝试上限的任务不会被 resume 清零，未知外部结果也没有“强制重发”按钮。

## 接口与模块接入

HTTP 继续使用 `{ code, data, message }`，所有接口要求登录并限定当前 owner。以下路径均带 `/api`：

| 接口                                  | 用途                                         |
| ------------------------------------- | -------------------------------------------- |
| POST /tasks/diagnostics               | 以 requestId、steps 创建步骤诊断             |
| POST /tasks/model-probes              | 持久执行 F03 诊断参数，lane 固定 background  |
| GET /tasks                            | status、companionId 筛选，afterId/limit 分页 |
| GET /tasks/:id                        | 当前状态、检查点、模型引用和有界尝试历史     |
| POST /tasks/:id/pause、resume、cancel | 持久控制，正文为空对象                       |
| GET /tasks/outbox                     | outbox 有界分页，转交与处理分别显示          |
| GET、PUT /tasks/config                | 查询/发布完整调度配置                        |
| GET /tasks/config/versions/:version   | 查询历史配置                                 |

`TASK_LEASE_LOST`（40910）和 `TASK_STATE_CONFLICT`（40911）在 contracts 中统一维护。对外不返回领取令牌、原始异常、数据库连接串或任务输入。后台模型诊断为恢复需要将输入存入主库，因此不要把秘密作为诊断输入；这与 F03 同步诊断不保存输入的行为不同。

- `TaskStore` 管理短事务与调度锁；`TaskConfigurationService` 管理版本和唯一默认值来源。
- `TasksService.claim/heartbeat/checkpoint/complete/fail/block` 是服务端 worker 协议，不作为 HTTP 管理接口暴露。
- `complete` 的领域回调可在同一连接内写入业务结果、确切进度和 outbox；回调必须重新核对所属模块版本，不得调用模型/工具。抛错则包括任务完成在内全部回滚；重放已成功提交不会再次调用回调。
- `stageMessageOutbox` 只能在所属业务事务中调用。转交任务与 outbox 完成同事务，不存在“已确认待办但任务未保存”的中间状态。
- 模型入口可接收 `ModelDispatchGuard`，在预留/派发短事务中核对租约；模型事务的锁顺序先模型配置、后任务调度，任务事务不能反向调用模型事务。任务取消在提交任务状态后再调用模型取消。
- 新业务处理器需要定义输入版本、范围验证、检查点及原子领域提交。本轮没有开放任意任务代码、任意外部地址或工具执行权限。

验证记录以 [开发进度](../progress.md) 为准。外部工具“已发送但结果未知”的核对接入按 F12 实现；不能把此处的数据库幂等当成外部动作恰好执行一次。目标主机负载、队列积压与磁盘增长仍需后续实测。
