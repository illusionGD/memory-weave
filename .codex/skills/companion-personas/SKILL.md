---
name: companion-personas
description: 维护 F05 伴侣初始人格、模板、约束和版本，接入聊天或成长时复用其来源与采用边界。
---

# 伴侣人格维护

先读 `docs/features/f05-companion-personas.md`、架构 M01 和当前 contracts；涉及调用或调度时同时遵循 model-runtime、durable-tasks。测试沿用 plan §7 已确认的 HTTP 命令/查询、模型供应商、任务恢复和 Web 边界。

- 一段原稿即可创建并自动整理，不增加逐字段审批。模板可选，名字可选。
- 原始快照、首次整理版本、当前版本必须独立。模板更新不影响旧实例，不复制私聊、成长或关系。
- 原稿来源始终是 initial_setting。当前人格使用 document，profileText 只用于溯源，不把初始倾向永久重注入当前上下文。
- core 保存身份/背景，inclinations 可成长，knowledge 不当作爱好，locks 只承接明确约束。未来成长不得自动改写 core/locks。
- 模型输出只包含候选与原稿依据；结构校验后再次验证引文。不能让模型决定身份、版本、权限或来源类别。
- 模型调用不持有数据库事务。锁顺序为模型配置头 → 调度头 → 实例；禁止在 TaskStore 回调内调用 ModelConfigurationService/ModelRuntimeService 的事务。
- 原稿和任务原子保存；采用与任务成功原子提交。提交检查 owner、epoch、当前版本、有效租约和 foundation.taskId；迟到结果不写回。
- 自动恢复沿用任务模型 requestId。未知结果不得换键补发，包括先取消再重试；保留用量和所有历史。
- 初始整理定义当前为 persona-initial-v1 / persona-initial-v1 / utf8-v1。只在显式启用时为旧 probe-v1 占位配置追加定义绑定，不能改供应商、模型、价格或限额，不能覆盖自定义定义。
- test adapter 不做语义整理，前端必须标明；接真实/本地模型要求 structured 能力和价格配置，单独评估语义效果。
- 约束修订只追加版本，按 expectedPersonaVersion 和 runtimeEpoch 检查；同键重放不重复追加。人格版本查询显式限定实例和代次。
- Web 按页读取，离开时丢弃旧请求结果；网络重试复用命令身份，不在 localStorage 保存私人原稿。版本输入不得被迟到刷新覆盖。
- 已交付 SQL/快照/journal 历史不可改写，后续只能追加迁移。按 Node 22、中文注释、无后缀 TS 导入和共享契约规则维护。
- 验证必要的隔离 MySQL 测试、浏览器流程、验收脚本和保留卷升级/恢复；不能用测试模型结果宣称真实语义能力。阶段完成后停在该功能供 review。

F07 已接入生命周期限制与清理。涉及消息来源、实例代次、任务恢复、模型候选或人格版本的改动，需同时阅读 [lifecycle](../lifecycle/SKILL.md)，接入读取/派发/提交检查及分批清理协议，保留共享原文和全局计量边界。
