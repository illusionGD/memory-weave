---
name: memory-retrieval
description: 维护 F09 检索、新原文补读、Qdrant 空间、索引任务与跨会话来源。
---

# 记忆检索维护

先读 `docs/features/f09-memory-retrieval.md`、`evaluations/retrieval/f09-corpus.json`、当前 contracts 和 plan §7；同时遵循 coding、tdd、memory-organization、private-chat、model-runtime、durable-tasks、lifecycle。测试边界已有授权，无须重复确认。

- 检索适用于普通陈述，不靠问号触发。原始查询与有限前文分开；不得把查询改写生成的实体当事实。
- 首版跨会话只允许同用户与同伴侣、同代次的私聊。群聊不读取私聊；SQL 在所有渠道后复核归属、版本、可见性和来源，不能信任 Qdrant payload 或排名本身。
- 普通查询只取当前头；历史版本、纠错、现实/故事、发生/收到/认识时间和分歧不得混为一个真相。时间近本身不证明相关。
- 未整理补读按实例的精确 processing_ranges 查询完整原文，预算不足明确传递覆盖缺口。当前必要输入不能被旧记忆挤掉。
- MySQL 权威记忆提交与派生文档/词项登记同事务。外部 embedding、Qdrant 写删均在锁外；模型调用沿统一配置、请求身份、并发与预算入口。
- collection 按部署与编码空间隔离。模型、端点、维度、编码版本改变要新空间；点 ID 固定记忆版本。当前版本才建向量，旧版本通过数据库历史路径取得。
- 索引任务与记忆整理共享后台位置，清理独立。成功编码可复用，未知结果不换键重发；Qdrant 故障有限重试，显式重试保留旧任务。不要让外部 GC 阻塞聊天领取循环。
- chat-v2 固定精确召回来源及 querySources 片段，MySQL JSON 重排后仍须生成完全一致 inputText。保留旧 chat-v1 定义与已固定输入的恢复语义。
- 新来源必须接入 chat_run_sources/chat_memory_sources，以及无正文 memory_original_sources。重置不能抹掉以后删除原文所需的身份关系。删除传播及外部清理走生命周期 v3，保留旧阶段解释；迟到点仍需权威检查和持久补偿。
- 不将测试编码称为语义检索。固定语料期望人工标注；真实模型、全链路容量与合成索引实验分别报告。改分词、阈值、融合及编码前回归相同语料。
- 0000–0007 发布后不可改写，追加迁移。公共 HTTP、真实 MySQL/Qdrant、强杀恢复、网页与保留卷升级是验收边界。完成当前功能提交推送授权 dev，停在该功能供 review。

F10 已加入管理端记忆浏览、时间线及来源关系图。涉及浏览范围、图谱或生命周期视图失效时，同时阅读 [memory-explorer](../memory-explorer/SKILL.md)。
