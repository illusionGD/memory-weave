---
name: memory-organization
description: 维护 F08 批量记忆整理、来源版本、独立处理范围、模型恢复及删除传播。
---

# F08 记忆整理

先读 [功能说明](../../../docs/features/f08-memory-organization.md)、架构 §7、plan/progress 及 coding/tdd/data-foundation/durable-tasks/model-runtime/lifecycle。沿用 plan §7 已确认的 HTTP、worker、模型协议、浏览器和进程恢复边界。

- 原文发布、逐实例 pending 范围及 outbox 同事务。F08 outbox 只确认持久登记，不再创建逐条占位任务。旧占位任务保留历史，不自动发模型。
- MEMORY_CONFIG_JSON 集中控制自动整理；每批固定完整来源、前置上下文、旧记忆、权限版本及配置快照。超限阻塞，不能截断后推进整条完成；不扫描全部聊天历史。
- 模型 memory/structured 使用 memory-extraction-v1。test 返回零候选，不能声称验证真实提取质量。旧 probe-v1 只有明确整理/重试才升级定义，不静默更换模型或上调预算。
- 新增、合并、修订（变化/纠错）、分歧、暂不成条目均保留其含义；一次非法来源或版本冲突使整批回滚。结果、任务完成及 processing_ranges 的确切范围同事务，不能用最大序号跨过空洞，不能由 A 代替 B。
- 精确证据保存消息版本及偏移，查询原文时再次检查权限；正文不重复拷贝到证据表。旧版本依赖使用 memory_dependencies，仅指向已存在版本；不得扁平复制全部祖先，也不能因同文去重制造依赖环。转述次数不作独立可信权重。
- batch ID 固定输入，task ID 固定模型请求；恢复复用已保存结果。未知外部结果阻塞，不换键补发；已知失败显式重试生成新批次并保留历史与计量。
- worker 为记忆和生命周期各保留一个独立位置，普通 maxConcurrent 不被后台模型等待耗尽；F03 全局与后台预算仍是模型派发边界。
- 生命周期协议 v2 接入记忆版本传递失效、幸存原文重新排队、证据和批次输入清理；v1 检查点不能重解释。所有读取/派发/提交均验证代次和会话限制。重置 A 保留 B 合法记忆及共享原文。失效当前版本不能自动回退成旧事实。
- F08 旧记忆匹配限定同会话的近期候选；F09 再做跨会话混合检索、即时补读及回复注入，扩展范围时必须同步扩展来源删除围栏。F10 完善管理，F15 接入反思与人格成长。
- 已发布迁移 0000–0006 不改写；新结构追加。修改后跑真实隔离 MySQL、HTTP fixture、强杀恢复与未知结果、并发聊天、删除/重置隔离、浏览器，以及保留卷升级/重启；同步 README/plan/progress 和相关技能，按已有授权在 dev 提交推送后停在当前功能 review。

F09 已接入记忆检索、跨私聊来源及 Qdrant 索引。涉及上下文、版本、后台调度或删除恢复时，同时阅读 [memory-retrieval](../memory-retrieval/SKILL.md)，保留固定输入与无正文来源图。

F10 已加入管理端记忆浏览、时间线及来源关系图。涉及浏览范围、图谱或生命周期视图失效时，同时阅读 [memory-explorer](../memory-explorer/SKILL.md)。
