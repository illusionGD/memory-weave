# F03 模型接入、集中配置与预算

比较基线：`c89dd7c`。本功能提供独立于模型厂商的任务入口、配置版本、调用计量与隔离诊断。完整聊天、记忆整理和人格成长由后续功能实现；诊断成功不表示伴侣已经聊天或成长。交付版本与验证记录见 [开发进度](../progress.md)。

## 本次范围

- 确定性 `test` adapter：不联网，用固定结果验证程序行为，明确标注测试身份。
- OpenAI 兼容 adapter：一次 HTTP 尝试，支持非流式 Chat Completions 文本/结构化生成和单条 Embeddings。兼容服务可包括本地模型；只声明部署者实际配置的能力，不默认为所有模型都支持全部功能。
- 任务独立配置：`chat`、`persona`、`memory`、`reflection`、`growth`、`growth_validation`、`relationship`、`retrieval`、`embedding`。提案和追加验证仍是不同调用。后续业务模块各自定义提示词与校验，不能用诊断的 ok/reply 规范替代真实业务规范。
- 配置按完整版本发布；读取返回版本及 default/deployment 来源。同幂等键重放不新增版本，旧版本更新冲突，历史不可覆盖。回滚时读取旧配置并发布为新版本，已用量保留。
- 全局及任务的 UTC 每日请求、token、费用额度；交互与后台并发分开。当前只有部署级和任务级配置，实例级覆盖、活动/互聊的整场额度在对应功能接入。
- 同一调用内每次尝试单独记录；结构、向量维度、完整输出、用量、取消和过期结果都经过程序检查。错误结果不会写入人格、消息、记忆或 Qdrant。

供应商 API、模型语义、价格与真实吞吐量需要实际服务验证。本次协议验证使用真实本地 HTTP 供应商夹具，不能据此声称某个外部型号已经通过语义评估。工具、视觉和流式能力当前明确为 false，随 F06/F11/F12 接入；持久任务调度已由 [F04](f04-durable-tasks.md) 接入；本文记录 F03 的模型基础范围。

## 本地升级与验收

保持现有 MySQL、Qdrant 配置。先停止旧 `pnpm dev`，在项目根目录执行：

```powershell
git pull --ff-only origin dev
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev
```

另一个项目终端运行：

```powershell
pnpm verify:f03
pnpm models:config show
pnpm models:config usage
```

验收脚本通过已登录 HTTP 接口执行 13 项检查：配置回查、三类调用、结果规范、幂等重放与冲突、详情与计量。它持久保存 3 条诊断调用，只允许 chat 和 embedding 都使用 test；不会自行切换模型或调用付费接口。运行时避免其他并发调用；脚本的增量期望为 3 次请求和 52 个测试 token。诊断输入不保存，但经过校验的输出会保存在调用记录中。

浏览器入口仍为 `http://localhost:5173`，本轮未增加模型配置页面。已运行整套 Docker 时，在执行命令的终端设置：

```powershell
$env:VERIFY_BASE_URL = 'http://localhost:8080'
pnpm verify:f03
pnpm models:config usage
Remove-Item Env:VERIFY_BASE_URL
```

## 配置真实或本地模型

### 1. 部署登记供应商

复制 `deploy/models.env.example` 为根目录 `.env.models`。该文件已忽略，不能提交；dev、start 与 Docker app 都读取它，修改后重启对应服务。Docker Compose 需要支持可选 env_file 的 v2.24.0 或以上版本。没有此文件也可启动。

示例：

```dotenv
MODEL_PROVIDERS_JSON='[{"id":"openai","baseUrl":"https://api.openai.com/v1","apiKeyEnv":"MODEL_OPENAI_API_KEY","capabilities":["text","structured","embedding"],"outputTokenParameter":"max_completion_tokens","structuredFormat":"json_schema","sendEmbeddingDimensions":true}]'
MODEL_OPENAI_API_KEY=填写你自己的密钥
```

`baseUrl` 是带 `/v1` 等实际路径的服务根地址，不能带账号、密码、查询参数或片段。API key 通过以 `MODEL_` 开头的环境变量名引用，不在普通配置、导出或诊断响应中返回。无认证的本地服务显式填写 `apiKeyEnv: null`，并按实际能力列举 capabilities。Docker 内访问宿主机时不能用容器的 127.0.0.1；Windows Docker Desktop 可使用 `host.docker.internal`，Linux 需配置可达地址与相应 host-gateway 映射。

兼容参数均由部署者明确选择，不在失败后静默降级：

| 参数                    | 默认与含义                                                                       |
| ----------------------- | -------------------------------------------------------------------------------- |
| outputTokenParameter    | `max_completion_tokens`；旧兼容服务可选 `max_tokens`                             |
| structuredFormat        | `json_schema`；仅支持 JSON object 的服务可选 `json_object`，本地严格校验始终执行 |
| sendEmbeddingDimensions | `true`；不支持 dimensions 参数的服务设 false，返回向量仍必须匹配任务维度         |

运行 `pnpm models:config providers` 查看能力、凭据是否就绪与部署上限，不主动探测或发起付费请求。

### 2. 发布任务配置

```powershell
pnpm models:config export
# 编辑生成的 model-config.local.json
pnpm models:config apply
```

导出文件包含 requestId、expectedVersion、完整 config 和 evaluationNote。保留前两项，修改所需任务及评估说明后发布；重复提交同一文件不会产生新版本。后续修改重新导出新文件，例如 `pnpm models:config export model-config-next.local.json`，发布时指定相同文件名。自定义路径需自行放在不提交的目录；默认文件已忽略，export 不覆盖已有文件。

至少设置目标任务的 providerId、供应商实际接受的 model、输入/输出价格和预算。生成模型与 embedding 分别配置；修改 chat 不自动改变 memory/reflection/embedding。业务模型或提示词切换须按 [架构 §13.1](../architecture.md#131-模型分工与稳定性) 先在隔离数据上评估，evaluationNote 记录依据，不代表程序已完成语义评估。

价格使用**每百万 token 对应的微美元**：例如输入价 2 美元/百万 token，填写 `inputMicrosPerMillion: 2000000`。测试默认价格为 null，test adapter 按免费计量；切到外部供应商后 null 会阻止请求。免费本地推理可明确填零。价格是部署者提供的计量估算，不是供应商账单；缓存、阶梯费率与额外服务费用尚未建模。

初始普通配置：全局每日 1000 次、100 万 token、100 万微美元（1 美元），总并发 2、后台并发 1；每任务每日 100 次、10 万 token、1 美元。生成单次输入预估上限 8192、输出 512、超时 30 秒、尝试 1 次、重试等待 250 毫秒；embedding 输出上限为零，测试维度为 4。使用真实 embedding 时必须明确填写实际维度。

部署上限由 `MODEL_HARD_LIMITS_JSON` 设置，默认每日 10000 次、1000 万 token、10 美元，总并发最多 4、后台最多 1。普通配置不能提高部署上限；重新部署降低上限时，即使历史配置更高，新派发也使用较低值。后台并发始终小于总并发，保留交互容量。其他模块参数随相应功能加入统一配置，不在本轮虚构未实现功能的开关。

## 调用、计量和失败规则

1. 校验部署、任务能力、价格、输入大小、实例代次/会话成员和配置版本；模型地址只来自部署登记。
2. 在 MySQL 短事务中锁定当前部署配置行，同时检查全局及任务的请求/token/费用和并发上限，原子保存调用、尝试和两份额度预留。未通过额度检查时不发请求，不产生半份计量。
3. 事务外访问供应商；等待重试后再次检查取消、配置和范围。每次请求记录实际任务定义、配置版本、关联实例和会话。
4. 完整输出按任务本地 Zod schema 校验，结构化输出还需为可序列化 JSON；embedding 检查数量、有限数值和维度。截断、拒答、工具调用、错误字段和格式失败都不作为可用结果。
5. 上报用量有效时按原价格、原 UTC 日窗口结算，即使跨日完成也不把旧预留扣到新一天。供应商超出预估时如实增加占用，后续调用受剩余额度限制，不能把真实用量截成配置上限。
6. 返回有效结果但没有用量时，可提供候选，但保留预留并显示 `usageSource: reserved`。输出是否可用与消耗是否已知分别记录。

输入预留使用 UTF-8 字节数、系统提示词、JSON schema 和协议余量作保守估计，不宣称等同供应商 tokenizer。单次生成额外预留最大输出 token；金额按整数微单位向上取整。

明确的 429、500、502、503、504 响应可在配置的 1–3 次总尝试内重试；每次都重新预留并计量。网络中断、超时或进程退出导致结果不明时不自动重发。同一 requestId 重放返回已有调用；同键异内容返回冲突。已预留后遇到取消或状态变化也保守保留预留，不把不确定的计量自动退回。

取消先写持久状态，再中止本进程等待；不能承诺供应商停止计算或退费。其他进程仍可能完成原请求，但迟到输出不能恢复已取消/过期调用为成功；可观察用量仍结算。客户端断开不自动取消，应使用取消命令。进程中断后的过期识别在查询或新派发时执行，保留原窗口预留；本轮不做后台定时扫描或供应商账单补查。

配置修改、回滚、重启不清零额度。窗口固定 UTC，展示时区不参与额度键。新配置出现时正在发出的请求按原快照结算，旧调用停止后续重试，不混用新模型。领域提交仍须再次检查来源、版本、代次和生命周期；通用模型成功不是人格成长的提交指令。

## HTTP 与代码入口

所有接口需要部署登录，沿用 `{ code, data, message }`。`POST probes` 创建的诊断资源即使模型失败也返回 201，必须检查 data.status/errorCode；发送前的权限、版本、能力和预算拒绝仍使用对应 HTTP 错误。错误正文不返回供应商原文。

| 接口                                     | 行为                                           |
| ---------------------------------------- | ---------------------------------------------- |
| GET /api/models/providers                | 已登记能力、凭据就绪状态及部署上限             |
| GET /api/models/config                   | 当前完整配置、来源及版本                       |
| GET /api/models/config/versions/:version | 不可变历史配置                                 |
| PUT /api/models/config                   | 按 expectedVersion、requestId 发布完整配置     |
| POST /api/models/probes                  | 隔离文本、固定结构化或向量诊断，输入不写调用表 |
| GET /api/models/calls/:id                | 调用结果与每次尝试、用量来源、期限和失败分类   |
| POST /api/models/calls/:id/cancel        | 幂等取消，返回 200，保留计量                   |
| GET /api/models/usage                    | 当前 UTC 日全局与任务额度、占用和有效并发      |

诊断请求例：

```json
{
  "requestId": "自行生成 UUID",
  "expectedConfigVersion": 1,
  "role": "chat",
  "operation": "structured",
  "inputText": "测试连接",
  "lane": "interactive"
}
```

公共类型和数字错误码在 `packages/contracts/src/models.ts` / `api.ts`。server 的 `modules/models` 分别维护配置、供应商登记、单次 adapter 和统一计量入口；`ModelRuntimeService.execute(command, definition, scope)` 为领域模块复用。结构化任务从同一 Zod 规范生成 JSON schema，再做本地校验；确定性 adapter 可由模块提供固定测试输出，不模拟真实语义能力。

新增五张表：model_configuration_heads、model_configuration_versions、model_calls、model_attempts、model_usage_windows。`0001_model_runtime` 只追加新结构，原 F02 表和 MySQL 初始迁移不改写。更新前停止旧应用，运行 db:migrate；Compose 同样先迁移再启动。MySQL DDL 中途失败会保留 applying 并阻止就绪，应恢复升级前备份；开发阶段可重建明确的测试库，不手工伪造成功历史。

## 技术依据与待验证项

沿用现有 Node fetch、Zod、Drizzle，不增加 SDK 或编排框架依赖。相比直接采用供应商 SDK，本实现能保证每次实际 HTTP 尝试由同一处显式预留及计量，避免 SDK 自动重试绕过预算；代价是自行维护当前协议子集。供应商 SDK 可后续作为单次 adapter 引入，LangGraph 等编排框架需等实际持久流程复杂度证明必要性。

2026-10-28 查阅 OpenAI 官方 [Chat Completions 类型](https://github.com/openai/openai-node/blob/master/src/resources/chat/completions/completions.ts)、[Embeddings 类型](https://github.com/openai/openai-node/blob/master/src/resources/embeddings.ts) 和 [重试说明](https://github.com/openai/openai-node#retries)。这支持当前请求格式、维度与用量字段的选择；不同兼容供应商支持程度、模型效果、完整费用与目标服务器容量仍待实际配置后验证。
