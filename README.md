# Memory Weave

维护持续身份、记忆与成长的 AI 伴侣系统。后端保存状态，浏览器提供使用入口。

**当前功能：F02 数据与会话基础。** 已提供登录、运行检查、版本化数据库迁移，以及实例、会话、原文发布和独立接收的 HTTP 接口。伴侣创建页面、模型聊天、自动成长和记忆整理按后续阶段加入；本版本不需要大模型 API 密钥。

- [架构设计](docs/architecture.md)
- [开发计划与功能清单](docs/plan.md)
- [开发进度](docs/progress.md)
- [F01 验收与实现说明](docs/features/f01-foundation.md)
- [F02 接口、迁移与验收说明](docs/features/f02-data-foundation.md)
- [各终端共用的 HTTP 响应与错误约定](docs/api-conventions.md)

## 拉取与开发启动

准备 Node.js **22.20.0 或以上的 22.x**、pnpm **11.25.0**、Docker Engine 与 Compose v2。推荐使用 `.nvmrc` 中的 **22.23.4**，Docker 同步采用该版本；CI 同时验证最低版本与推荐版本。当前锁定工具链的版本要求合并后，以 22.20.0 为最低支持版本；较早的 22.x 需要先升级。使用 pnpm 锁文件安装依赖。

```bash
git fetch origin
git switch dev
git pull --ff-only origin dev
pnpm install --frozen-lockfile
pnpm run setup
docker compose --env-file .env -f deploy/compose.yaml up -d --wait database
pnpm db:migrate
pnpm dev
```

打开 **http://localhost:5173**。在本地生成的 `.env` 中查看 `ADMIN_PASSWORD`，将它填入登录页的“部署密码”。`pnpm run setup` 生成随机数据库密码和登录密码，不输出到日志，也不覆盖已有 `.env`。

已有 F01 数据卷可直接执行 `pnpm db:migrate` 升级，无需删除数据卷。每次拉取涉及数据结构的新版本后，先停止旧应用、运行迁移，再启动新应用。`pnpm db:status` 可只读检查；迁移命令可重复运行，不会重新创建已有实例。

开发模式由 Vite 将 `/api` 转发到 `127.0.0.1:3000`，后端与数据库默认仅监听本机。若修改数据库端口，需同时更新 `.env` 中的 `POSTGRES_PORT` 和 `DATABASE_URL`；首次初始化后，数据库卷中的密码不会随环境变量自动改变。

`pnpm dev` 直接读取 `packages/contracts/src`，不需要先构建共享包。修改共享 schema、常量或新增导出后，前端由 Vite 热更新或自动刷新，后端由 tsx 自动重启；类型提示和 `pnpm typecheck` 也直接使用源码。后端重启会清空当前内存登录会话，需要时重新登录。修改 `package.json`、依赖或开发配置后应重新安装依赖并重启 dev；生产部署继续使用 `pnpm build` 生成的产物。

登录后可从页面顶部进入“个人设置”，修改用户的显示名称。默认名称为“用户”，去掉首尾空白后为 1～80 个字符；保存后刷新或重启仍保留。名称用于显示，不参与登录，也不会改变历史消息的用户身份关联。已有 F02 数据同样需要先执行 `pnpm db:migrate` 添加资料字段。

## 用 Docker 启动整套系统

在上面安装配置步骤完成后运行：

```bash
docker compose --env-file .env -f deploy/compose.yaml up -d --build
docker compose --env-file .env -f deploy/compose.yaml ps
```

打开 **http://localhost:8080**。Compose 会先等待数据库可连接，再执行一次性 `migrate` 服务，成功后启动应用；迁移失败时应用不会按就绪状态启动。查看升级结果使用 `docker compose --env-file .env -f deploy/compose.yaml logs migrate`。后端镜像同时提供构建后的 Web 页面，因此运行时不需要单独的 Vite 服务。

服务器只有 Docker 时，可先复制 `.env.example` 为 `.env`，填写独立随机的 `POSTGRES_PASSWORD` 和至少 12 字符的 `ADMIN_PASSWORD`，然后执行上述 Compose 命令。Compose 自行构造容器数据库连接串，不依赖宿主配置中的 `DATABASE_URL`；在该方式下可以将其留空。其他环境变量仍按示例设置。

数据库和应用文件分别保存在 Compose 的持久卷中。普通停止使用：

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

HTTP 测试验证真实 NestJS 接口和 PostgreSQL。运行 `pnpm test` 前，必须设置指向独立测试 PostgreSQL 的 `TEST_DATABASE_URL`；该角色需要创建/删除临时数据库及创建 vector 扩展的权限。测试只在随机命名的临时数据库内写入业务数据，并清理自己创建的库；不提供测试连接会明确失败。浏览器测试启动独立服务，覆盖桌面和移动视口。

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
- F01 的会话存于单后端进程，最多 10 个会话，有效期 12 小时；退出会立即撤销，后端重启后需要重新登录。实例、会话和消息已持久化；后台任务由后续功能实现。
- 登录限制为每个直接连接来源每分钟 5 次，当前不信任转发的来源 IP；使用反向代理时，同一代理后的请求共享该基础额度。
- `.env`、凭据、数据库文件、附件和浏览器测试产物不进入 Git。

## 逐功能 review

持续在 `dev` 分支开发。每个功能完成检查后提交并推送，交付固定 SHA、比较基线、测试结果和验收步骤。评审修复追加提交；按功能暂停交付 review，特殊需求才额外开分支。记录位于 `docs/progress.md`。

项目许可证：[Apache-2.0](LICENSE)。
