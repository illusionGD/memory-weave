# F23 模板、备份与恢复

## 人设模板

- `GET /api/persona-templates/:id/export` 导出当前模板。`GET /api/persona-templates/:id/versions/:version/export` 导出指定的不可变版本。
- `POST /api/persona-templates/import` 接受 `requestId` 和 `bundle`。导入校验版本、字段和 SHA-256，并创建新的模板身份。模板只包含原始人设、名称和显式锁定项。

## 部署备份

一次备份覆盖本部署的所有伴侣、共同会话、记忆、人格版本、活动、模型和任务状态。业务表保存为具名列的 JSONL，原件按稳定引用复制，`manifest.json` 保存迁移版本、行数、文件尺寸及 SHA-256。配置密钥仍由部署配置提供，Redis 登录会话与 Qdrant 派生点不写入包。请在部署外保存业务备份和独立生命周期日志，并按维护周期共同保管。

1. 停止后端进程，保留 MySQL、Redis、Qdrant。`pnpm data:archive export /绝对路径/备份` 需要独占当前数据库，目标目录由命令创建。绑定到容器的文件目录允许容器内的 `node` 用户写入。
2. 用 `pnpm data:archive inspect /绝对路径/备份` 核对完整性。另行同步 `LIFECYCLE_JOURNAL_DIR` 到独立存储。默认路径为 `${DATA_DIR}.lifecycle`，Compose 将其挂载到单独的 `lifecycle-journal` 数据卷。
3. 删除、重置、移除或退出成员、关闭会话、撤销历史、关闭邀请权限及撤销终端授权在提交主库前同步少量限制记录。备份只保存已知日志的长度与校验值。恢复使用独立持有的最新完整日志。如果日志来自旧副本，不能据业务备份推定它就是最新版本。

## 离线恢复和升级

1. 准备全新 MySQL 数据库、空业务文件目录，以及未持有待恢复部署物理索引的 Qdrant。使用隔离 Redis 命名空间与认证密钥。把独立存储中的最新日志放到目标 `LIFECYCLE_JOURNAL_DIR`。
2. 使用备份清单对应的发布版本运行 `pnpm db:migrate`。随后在配置明确指向这些隔离资源的环境中运行 `pnpm data:archive restore /绝对路径/备份`。容器也支持 `node deploy/docker-entrypoint.mjs archive export|inspect|restore <备份目录>`。
3. 恢复先检查文件、结构、引用及日志前缀，然后导入主库并重放较新的生命周期限制。重放期间普通任务不派发，待处理的删除和重置完成后才解除启动围栏。`DATA_DIR/restore-result.json` 记录实际应用的日志版本。失败会保留启动围栏；修复外部条件后换新的隔离目标重新恢复。
4. 核对原件可读取、人格版本一致、删除或重置没有倒退、待办进度仍在，再启动目标。Qdrant 由当前版本重新构建。终端恢复后重新建立在线连接，已派发而缺少回执的动作保持结果未知。后续升级按版本应用追加迁移，保持主库与原件。

## 验证

`pnpm verify:f23` 使用真实的隔离 MySQL、Redis 和 Qdrant。验收从旧快照恢复附件、人格版本与后台待办，同时应用更新的明确删除、重置与关闭会话，核对文件篡改和缺失独立日志均导致恢复失败。
