# 模型 JSON 配置

供应商、各用途模型、参数、价格和预算由一个 JSON 文件决定。开发和正式环境使用独立文件，修改后重启生效；数据库只保留生效快照、历史和用量。

## 首次使用与升级

```sh
pnpm setup
```

该命令只创建缺失的 `config/models.development.json` 与 `config/models.production.json`，不会覆盖已有文件或轮换已有登录凭据。模板不含密钥；开发模板使用不联网的 test 模型，正式模板所有任务默认关闭。

原来在 `.env.models` 中填写 MODEL_PROVIDERS_JSON / MODEL_HARD_LIMITS_JSON 的部署，需要把内容分别移到 JSON 的 providers / hardLimits，删除这两个旧环境变量。旧变量残留时启动会明确报错；不会暗中覆盖文件。

旧数据库中的模型配置不会自动导入文件。升级前可读取原有当前配置并保留，填写到 JSON 的 configuration。首次重启按文件追加快照，旧记录和用量不删除；本次无数据库迁移、无需 db:reset。

## 文件选择

| 启动方式                       | 默认文件                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------- |
| pnpm dev / dev:web / dev:admin | config/models.development.json                                               |
| pnpm start                     | config/models.production.json                                                |
| 直接运行后端                   | NODE_ENV=production 使用正式文件，否则 development/test 使用开发文件         |
| Docker                         | 只读挂载 config/models.production.json 到 /app/config/models.production.json |

`MODEL_CONFIG_FILE` 可以指定绝对路径，优先于默认文件。默认单仓库路径按程序位置计算；dev/start 明确传递绝对路径，不依赖当前 shell 目录。独立生产包必须显式配置绝对路径，Docker 已设置。

JSON 只区分模型配置；正式与开发仍需要独立的 MySQL、Qdrant、Redis 命名空间和附件目录。并行进程必须使用同一份生效配置，当前推荐单实例运行。

## 配置内容

| 字段          | 作用                                                             |
| ------------- | ---------------------------------------------------------------- |
| providers     | id、baseUrl、apiKeyEnv、capabilities、streaming 和供应商接口参数 |
| hardLimits    | 部署每日额度及并发硬上限                                         |
| configuration | 全局预算、并发和 tasks 下各用途的模型、调用参数、价格与独立预算  |

模板包含完整配置，没有多层继承或隐式合并。VS Code 已关联 `config/models.schema.json`，其他编辑器可关联同一 Schema。promptVersion、schemaVersion、preprocessingVersion 对应当前代码的任务定义，保持模板值；它们不是供应商的模型名称。供应商实际模型版本填写 model。

供应商示例（作为 providers 中的一个条目）：

```json
{
  "id": "openai",
  "baseUrl": "https://api.openai.com/v1",
  "apiKeyEnv": "MODEL_OPENAI_API_KEY",
  "capabilities": ["text", "structured", "embedding"],
  "streaming": true,
  "outputTokenParameter": "max_completion_tokens",
  "structuredFormat": "json_schema",
  "sendEmbeddingDimensions": true
}
```

将实际密钥放在 `.env.models` 或 PM2 环境变量中；JSON 只引用环境变量名。无密钥本地服务可设置 apiKeyEnv 为 null。不要把密钥直接写进 JSON，未知字段会被拒绝。

每个启用的真实模型必须登记所需能力、配置价格和凭据；本地免费模型显式填零价。价格与预算继续使用 USD 微单位，1 美元 = 1,000,000 costMicros；inputMicrosPerMillion/outputMicrosPerMillion 表示每百万 token 的微美元价格。资源关系、向量维度与任务定义在启动前校验，不先发请求试错。

## 查看、检查与生效

```sh
# 默认检查开发文件；可提供相对或绝对文件参数。
pnpm models:config check
pnpm models:config check config/models.production.json
pnpm models:config show config/models.production.json

# 服务已启动后，查看实际生效快照、供应商能力和用量。
pnpm models:config status
pnpm models:config providers
pnpm models:config usage
```

check/show 不连接数据库或模型供应商，不需要 build。show 不输出密钥值。status 等读取命令使用已有登录凭据与 VERIFY_BASE_URL / APP_ORIGIN；正式环境按实际入口设置。

check 输出文件指纹；status 返回当前生效指纹。修改文件不会改变运行中的快照，重启后才同步。相同内容重启不新增版本，配置或非秘密供应商定义变化追加新版本；调整密钥值不写入历史或指纹。

文件管理的服务拒绝 PUT /api/models/config；apply 命令已经取消。回滚方式是恢复旧 JSON 并重启，仍追加新快照。内部占位任务定义不能修改文件配置，必须与模板对应的定义一致。

每日已用额度、调用记录和历史不清空。旧任务不自动切换到新模型重试；沿用任务配置版本冲突及未知调用处理。向量模型变化仍使用现有独立索引空间与重建机制，不覆盖旧向量。

## PM2 与 Docker

已提供 `deploy/ecosystem.config.cjs`。构建并迁移后使用 `pm2 start deploy/ecosystem.config.cjs`，后续使用 `pm2 restart memory-weave`。正式 `.env` 需配置实际 APP_ORIGIN / ADMIN_APP_ORIGIN 和 Cookie 安全设置。PM2 按单实例 fork 配置，设置 `cwd` 为项目根目录，使用构建后的 `apps/server/dist/main.js`，环境中设置 `NODE_ENV=production` 和 `MODEL_CONFIG_FILE` 的绝对路径。通过 Node 22 的 `--env-file` / `--env-file-if-exists` 加载所需环境文件，或者由进程管理器注入环境。修改 JSON 后执行对应应用的 `pm2 restart`；修改 PM2 注入的环境变量时使用 `--update-env`。本次不代为部署服务器。

Docker 在启动前先执行 setup，并编辑正式 JSON。Compose 将实际配置只读挂载，不打进镜像；容器内路径固定。db:status / db:migrate 不依赖模型文件，db:reset 也不会读取模型选择，避免配置损坏阻止维护。

## 验证边界

实际入口 loadServerConfig 始终加载 JSON，没有环境变量开关恢复数据库可写配置。既有程序化故障测试可向 createApplication 注入无文件的配置对象，继续验收底层发布、并发及预算协议；这不是部署方式。独立 JSON 集成测试另外覆盖启动同步、拒绝 HTTP 写入、重启保持登录与用量等实际行为。

浏览器验收为默认 test 场景与非空记忆模型场景分别创建独立数据库和 JSON，并启动测试后端，不向运行服务写入测试模型；临时文件和 Redis 范围在验收结束时清理。使用的本地模型替身只验证协议，不证明真实模型质量。
