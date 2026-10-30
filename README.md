# Memory Weave

维护持续身份、记忆与成长的 AI 伴侣系统。后端保存状态，浏览器提供使用入口。

**当前功能：F09 记忆检索接入聊天，聊天端与管理后台已拆为独立项目。** 同一伴侣可延续不同私聊中的记忆，尚未整理的新补充直接参与下一轮；网页可展开本轮来源。MySQL 8.4.9 保存权威数据，Qdrant 1.18.3 保存可重建向量索引；反思与人格成长按后续阶段加入。

- [架构设计](docs/architecture.md)
- [开发计划与功能清单](docs/plan.md)
- [开发进度](docs/progress.md)
- [F01 验收与实现说明](docs/features/f01-foundation.md)
- [F02 接口、迁移与验收说明](docs/features/f02-data-foundation.md)
- [F03 模型配置、预算与验收说明](docs/features/f03-model-runtime.md)
- [F04 持久任务、恢复与验收说明](docs/features/f04-durable-tasks.md)
- [F05 伴侣创建、初始人格与模板验收](docs/features/f05-companion-personas.md)
- [F06 私聊、流式、补充打断与重连验收](docs/features/f06-private-chat.md)
- [F07 删除、重置、清理进度与恢复验收](docs/features/f07-lifecycle.md)
- [F08 批量记忆、来源、调度配置与验收](docs/features/f08-memory-organization.md)
- [F09 回忆来源、检索配置、索引恢复与验收](docs/features/f09-memory-retrieval.md)
- [聊天端与管理后台：启动、部署与验收](docs/features/frontend-split.md)
- [各终端共用的 HTTP 响应与错误约定](docs/api-conventions.md)

## 拉取与开发启动

准备 Node.js **22.20.0 或以上的 22.x**、pnpm **11.25.0**、Docker Engine 与 Compose **v2.24.0 或以上**。推荐使用 `.nvmrc` 中的 **22.23.4**，Docker 同步采用该版本；CI 同时验证最低版本与推荐版本。当前锁定工具链的版本要求合并后，以 22.20.0 为最低支持版本；较早的 22.x 需要先升级。使用 pnpm 锁文件安装依赖。

```bash
git fetch origin
git switch dev
git pull --ff-only origin dev
pnpm install --frozen-lockfile
pnpm run setup
docker compose --env-file .env -f deploy/compose.yaml up -d --wait mysql qdrant
pnpm db:migrate
pnpm dev
```

聊天端打开 **http://localhost:5173**，管理后台打开 **http://localhost:5174/admin/**。`pnpm dev` 同时启动后端和两个独立 Vite 项目；`pnpm dev:web`/`pnpm dev:admin`可只启动后端与指定前端。在本地生成的`.env`中查看`ADMIN_PASSWORD`，将它填入登录页的“部署密码”。`pnpm run setup` 生成或补齐 MySQL、Qdrant 与登录配置，不输出密码；已有登录密码和 MySQL 凭据保持不变。

从旧 PostgreSQL 版本更新时，先停止正在运行的 `pnpm dev`，再执行上述命令。setup 会将旧 `.env` 备份到 `.env.postgresql-backup`，切换到新的 MySQL 连接，并保留登录密码。按开发阶段约定，不迁移 PostgreSQL 数据；MySQL 使用新的 `mysql-data` 卷，旧实例和聊天不会出现在新库，旧数据卷不会被删除。已有旧 Docker 应用时，在 setup 后先执行 `docker compose --env-file .env -f deploy/compose.yaml down --remove-orphans` 停止旧服务，再启动新组合。

开发模式由 Vite 将 `/api` 转发到 `127.0.0.1:3000`。MySQL 默认监听本机 3306，Qdrant HTTP 默认监听本机 6333，两者均不对公网开放。修改端口时同步更新 `.env` 的 `MYSQL_PORT` / `DATABASE_URL` 或 `QDRANT_PORT` / `QDRANT_URL`。初始化后 MySQL 卷中的密码不会随 `.env` 自动改变；Qdrant 的访问密钥通过 `QDRANT_API_KEY` 配置，后端校验实际连接与访问权限。

后续 MySQL 结构更新时，停止旧应用、执行 `pnpm db:migrate` 再启动；`pnpm db:status` 可只读检查。迁移失败会保留未完成标记并阻止就绪，MySQL DDL 不保证整批回滚，恢复方式见 [F02 迁移说明](docs/features/f02-data-foundation.md#数据库迁移与部署)。

`pnpm dev` 直接读取 `packages/contracts/src` 和 `packages/browser-client/src`，不需要先构建共享包。修改共享 schema、常量或新增导出后，前端由 Vite 热更新或自动刷新；修改公共契约时后端由 tsx 自动重启，修改 browser-client 不重启后端；类型提示和 `pnpm typecheck` 也直接使用源码。后端重启会清空当前内存登录会话，需要时重新登录。修改 `package.json`、依赖或开发配置后应重新安装依赖并重启 dev；生产部署继续使用 `pnpm build` 生成的产物。

登录聊天端后可从导航进入“个人设置”，修改用户的显示名称。默认名称为“用户”，去掉首尾空白后为 1～80 个字符；保存后刷新或重启仍保留。名称用于显示，不参与登录，也不会改变历史消息的用户身份关联。MySQL 初始结构已经包含资料字段。

## 聊天外观与伴侣头像

聊天端使用简洁星空背景与扁平按钮；管理后台保持独立的管理界面。伴侣资料页和后台伴侣详情可上传、更换或恢复默认头像，支持 2 MiB 以内的 JPG、PNG、WebP 静态图，保存为居中裁切的 512px 头像。重置伴侣保留头像，删除实例会清理图片。升级需执行 `pnpm install --frozen-lockfile` 和 `pnpm db:migrate`，详见 [功能与验收说明](docs/features/starry-chat-avatars.md)。

## 伴侣创建与人设模板

登录后进入“伴侣”，填写一段人设即可创建，名字可选。原稿先保存，初始人格在后台自动整理，刷新后继续读取资料。聊天端保留创建和只读资料，管理端的「伴侣管理」提供当前/初始人格、历史版本、长期约束与任务控制；每次保存约束追加版本。

管理端的“人设模板”只复用初始设定，每次创建固定所选模板版本，修改模板不覆盖已有伴侣。旧 F02 实例不会在升级时自动调用模型，可以在详情主动开始整理。默认 test adapter 仅验证流程，页面明确标注，不代表真实语义整理效果。

```powershell
pnpm verify:f05
```

验收保留三位隔离测试伴侣和一个模板，只允许 persona 使用 test，产生三次测试模型调用。真实/本地模型、失败与取消、版本和 API 说明见 [F05 功能说明](docs/features/f05-companion-personas.md)。

## 私聊与流式回复

进入伴侣详情点击「开始聊天」，已有对话从聊天端导航「私聊」继续。发送时先保存原文，生成期间可继续补充，已发布内容保留，新一轮结合补充重新接话；刷新或离开不取消后端生成。默认 test 模型只回复固定测试文字，真实聊天需要配置 chat 模型及价格。

```powershell
pnpm verify:f06
```

脚本保留一位隔离验收伴侣、一个私聊和两条用户原文，只允许 chat 使用 test。`.env` 的 `CHAT_CONFIG_JSON` 集中配置合并等待、上下文条数和片段/连接资源；供应商在 `.env.models` 声明 `streaming: true` 后启用实际流式，否则整段返回。恢复、未知调用、SSE 代理设置和全部 API 见 [F06 功能说明](docs/features/f06-private-chat.md)。

### 删除与重置验收

在管理端伴侣详情的「实例管理」重置或删除，或在聊天端选择「删除这条消息」。删除消息后留在聊天并自动更新，管理端「清理记录」提供完整进度与恢复入口。重置从保存的初始人生开始，旧聊天只读；删除实例不自动删除共同原文。

```bash
pnpm verify:f07
```

脚本只创建并清理自己的两位验收实例和三条原文，不直接调用模型、不修改配置。F08 后这些原文可能触发后台测试整理；启用真实记忆模型时脚本会提前退出。先执行 `pnpm db:migrate` 再启动开发服务；完整 Compose 部署继续用 `up -d --build --wait`。批次参数、接口、依赖传播与备份边界见 [F07 功能说明](docs/features/f07-lifecycle.md)。

记忆整理验收：`pnpm verify:f08`。聊天端私聊可进入「这段对话的记忆」只读查看，自动整理照常运行；管理端「记忆记录」选择私聊后可点击「现在整理」并查看批次。默认测试模型返回空候选，验证独立范围和恢复；真实模型语义须另行评估。调度参数集中在 `.env` 的 `MEMORY_CONFIG_JSON`，升级新增 `0006_memory_organization`。详见 F08 功能说明。

回忆验收：`pnpm verify:f09`。聊天回复下方展开「本轮参考的记忆与新消息」。新增 `0007_memory_retrieval`，检索资源集中在 `.env` 的 `RETRIEVAL_CONFIG_JSON`。默认 test 不产生语义向量；使用真实模型前配置 embedding 角色及维度，不同编码空间不会混查。跨会话范围、删除传播和索引重建见 F09 功能说明。

## 模型基础验收与配置

服务运行后，在另一个项目终端执行：

```powershell
pnpm verify:f03
pnpm models:config show
pnpm models:config usage
```

F04 升级先停止旧应用并运行 `pnpm db:migrate`。worker 随后端自动启动，无需额外队列容器。另一个项目终端执行：

```powershell
pnpm verify:f04
pnpm tasks:config list
pnpm tasks:config outbox
pnpm tasks:config show
```

F04 保存两条隔离诊断并调用一次 test 模型，验证自动执行、幂等、结果关联与计量。失败、暂停和取消详情，以及配置导出/发布方式见 [F04 说明](docs/features/f04-durable-tasks.md)。消息发布会登记每个接收实例的独立待整理范围，由 F08 按批次处理；旧 `handler_unavailable` 占位任务保留历史，不代表记忆已经完成。

F03 验收脚本检查配置、文本/结构化/向量输出、幂等和计量，持久保存三条测试调用。默认无需真实密钥；脚本只允许 test adapter，不会替用户更换模型或调用付费服务。配置与预算目前通过 HTTP 和命令维护，模型管理页面后续加入。

使用真实或本地模型时，将 `deploy/models.env.example` 复制为根目录 `.env.models`，登记供应商和密钥引用，重启服务。dev、start 和 Docker app 都加载该可选文件；秘密文件不会提交或打入镜像。再导出普通配置，编辑 providerId、实际模型名、价格、预算和评估说明后发布：

```powershell
pnpm models:config providers
pnpm models:config export
# 编辑 model-config.local.json
pnpm models:config apply
```

真实供应商价格不能留空，免费本地模型显式填零。配置发布不会重置用量；模型切换只影响所修改的任务。供应商兼容参数、金额单位、默认值及失败语义见 [F03 说明](docs/features/f03-model-runtime.md)。从 F02 升级需先停止旧应用、执行 `pnpm db:migrate`；新增五张表，不修改原有实例和会话表。

## 用 Docker 启动整套系统

在上面安装配置步骤完成后运行：

```bash
docker compose --env-file .env -f deploy/compose.yaml up -d --build --wait
docker compose --env-file .env -f deploy/compose.yaml ps
```

聊天端打开 **http://localhost:8080**，管理后台打开 **http://localhost:8080/admin/**。Compose 会等待 MySQL 可连接，执行一次性 `migrate` 服务，并等待 Qdrant 健康后启动应用；迁移失败时应用不会按就绪状态启动。查看升级结果使用 `docker compose --env-file .env -f deploy/compose.yaml logs migrate`。后端镜像分别托管 `apps/web/dist` 与 `apps/admin/dist`，两端拥有独立入口、资源和路由，因此运行时不需要 Vite 服务。

服务器只有 Docker 时，可先复制 `.env.example` 为 `.env`，填写独立随机的 `MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`QDRANT_API_KEY` 和至少 12 字符的 `ADMIN_PASSWORD`，然后执行上述 Compose 命令。Compose 自行构造容器数据库连接串，不依赖宿主配置中的 `DATABASE_URL`；在该方式下可以将其留空。其他环境变量仍按示例设置。

MySQL、Qdrant 数据和快照、应用文件分别保存在 Compose 的持久卷中。Qdrant 保存 F09 可重建的记忆索引；默认 test 模型不创建无语义向量，F03 的 embedding 诊断也不写 Qdrant。普通停止使用：

```bash
docker compose --env-file .env -f deploy/compose.yaml down
```

该命令保留数据卷。`down -v` 会删除这些数据，不是日常停止或升级命令。

### 在云服务器访问

默认绑定 `127.0.0.1:8080`，适合由服务器上的反向代理提供 HTTPS。配置：

```dotenv
DEPLOY_APP_ORIGIN=https://你的实际域名
DEPLOY_COOKIE_SECURE=true
```

反向代理转发到 `http://127.0.0.1:8080`，浏览器访问上述域名。如果明确需要其他监听地址，再调整 `APP_BIND_HOST` 与服务器网络规则；数据库始终只在本机开放开发端口。修改 `.env` 后重新执行 `docker compose ... up -d` 使容器配置生效。

此仓库不提供长期在线服务器或既有测试网址。代码可以在本地或你自己的云服务器启动，当前会话的开发环境不等于正式部署。

### 需要代理证书的构建环境

普通部署不需要此配置。若运行环境通过 HTTPS 代理访问依赖仓库，并已提供 `CODEX_PROXY_CERT` 指向可信 CA 文件，可使用：

```bash
docker compose --env-file .env \
  -f deploy/compose.yaml -f deploy/compose.cloud.yaml \
  build app
docker compose --env-file .env -f deploy/compose.yaml up -d
```

CA 仅通过 BuildKit secret 挂载到网络构建步骤，不进入镜像层；TLS 验证保持开启。

JSON API 统一返回 `{ code, data, message }`，`code` 为数字；常用码与默认提示由 contracts 共用，业务也可自定义。前后端应一起升级，接口接入见 [HTTP API 公共约定](docs/api-conventions.md)。

## 常用检查

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

HTTP 测试验证真实 NestJS、MySQL 与 Qdrant。运行 `pnpm test` 前，必须设置指向独立测试 MySQL 的 `TEST_DATABASE_URL`，该角色需要创建/删除临时数据库的权限；另设置 `TEST_QDRANT_URL` 和 `TEST_QDRANT_API_KEY`。不要给生产应用账号授予跨库管理权限。测试只在随机命名的临时数据库内写入业务数据，并清理自己创建的库；不提供测试连接会明确失败。浏览器测试启动独立服务，覆盖桌面和移动视口。

服务启动后，另开一个位于仓库根目录的终端执行 `pnpm verify:f02`，通过 HTTP 验收 F02。脚本读取 `.env` 的登录密码，默认访问 `APP_ORIGIN`，可用 `VERIFY_BASE_URL` 指定其他入口。它会永久创建带“F02 验收”名称的实例和会话；重复执行会创建新的验收数据，不会删除或修改已有实例。

如果使用 Docker 的 8080 入口，PowerShell 中先指定验收地址：

```powershell
$env:VERIFY_BASE_URL = 'http://localhost:8080'
pnpm verify:f02
Remove-Item Env:VERIFY_BASE_URL
```

本地构建后也可不使用应用容器运行：

```bash
pnpm build
APP_ORIGIN=http://localhost:3000 pnpm start
```

此时访问 **http://localhost:3000**，Vite 无须启动。命令中的环境变量写法适用于 Bash 等 shell；其他终端在启动前设置同名变量即可。

## 当前访问控制边界

- 单用户部署密码来自服务端环境，浏览器使用 HttpOnly Cookie；不把会话密钥放入 localStorage。
- 后端默认要求 API 登录，公开例外为登录及基础健康检查；运行检查详情需要登录。
- 登录有频率限制；写操作核对浏览器 Origin。服务只接受配置的页面来源。
- F01 的会话存于单后端进程，最多 10 个会话，有效期 12 小时；退出会立即撤销，后端重启后需要重新登录。实例、会话、消息、人格版本和后台任务已持久化。
- 登录限制为每个直接连接来源每分钟 5 次，当前不信任转发的来源 IP；使用反向代理时，同一代理后的请求共享该基础额度。
- `.env`、凭据、数据库文件、附件和浏览器测试产物不进入 Git。

## 逐功能 review

持续在 `dev` 分支开发。每个功能完成检查后提交并推送，交付固定 SHA、比较基线、测试结果和验收步骤。评审修复追加提交；按功能暂停交付 review，特殊需求才额外开分支。记录位于 `docs/progress.md`。

项目许可证：[Apache-2.0](LICENSE)。
