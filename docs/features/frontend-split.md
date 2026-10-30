# 聊天端与管理后台分离

2026-10-30，基线 `f06f06c`。按用户要求拆分两个前端项目，延续 F09 功能；没有新增数据迁移，不改动已有伴侣、人格、聊天或记忆。

## 项目与职责

| 项目                                 | 使用范围                                                          | 视觉与工程边界                                                     |
| ------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/web` / `@memory-weave/web`     | 私聊、创建伴侣、只读资料、个人设置、只读记忆与原文来源            | 浅色、柔和留白、对话气泡；独立入口、路由、样式、构建               |
| `apps/admin` / `@memory-weave/admin` | 运行概览、伴侣实例与人格版本/约束、模板、记忆整理批次、清理与恢复 | 深色侧栏、蓝灰配色、表格和状态面板；独立入口、路由、样式、构建     |
| `packages/browser-client`            | HTTP 请求、响应校验、SSE 接口与错误处理                           | 纯 TypeScript，无 Vue、页面、路由、store；两端均依赖公共 contracts |

聊天端保留消息删除，接受操作后原位等待内容更新；完整清理详情在后台。管理端通过普通链接打开聊天端，不在管理路由内加载聊天页面。模型、预算与完整任务管理仍按后续阶段实施，目前继续使用已有 CLI / HTTP 接口。

两个项目不得互相导入组件、路由或 store。少量相同的资料表单和登录逻辑分别维护，允许独立演进；接口规则集中在 browser-client。接口仍使用共用的数字 `{code,data,message}`。

## 本地开发

```bash
pnpm install --frozen-lockfile
pnpm dev
```

- 聊天：`http://localhost:5173`
- 后台：`http://localhost:5174/admin/`
- API：`http://127.0.0.1:3000`

数据库的启动与迁移步骤沿用 README。已有 `pnpm dev` 需停止后重新启动；无需重新生成密码或清空数据。

`pnpm dev:web` 启动后端与聊天端；`pnpm dev:admin` 启动后端与管理端。后端已经运行时，可单独执行 `pnpm --filter @memory-weave/web dev` 或 `pnpm --filter @memory-weave/admin dev`。两个前端使用不同的固定端口，各自将 `/api` 代理到后端。

`dev` 脚本在 `ADMIN_APP_ORIGIN` 未设置时使用 `APP_ORIGIN` 的主机和协议、端口改为 5174。浏览器地址应与对应 origin 一致。直接单独启动 server 时，需自行设置 `ADMIN_APP_ORIGIN` 才能接受另一来源的写请求。后端只允许明确配置的两个来源，不放开其他端口或站点。

两个前端在 dev 使用 `memory-weave-source` 条件直接引用 contracts 和 browser-client 的 TS 源码，修改后由 Vite 热更新，无需先 build。后端只额外监听 contracts，修改纯浏览器客户端不重启后端或撤销会话。生产 `pnpm build` 则按依赖顺序生成共享包及两端的独立 dist。

## 部署与独立发布

默认 Compose 保留一个后端容器，托管两个独立构建产物：

| 地址                           | 产物 / 配置                                        |
| ------------------------------ | -------------------------------------------------- |
| `http://localhost:8080/`       | `apps/web/dist` → `/app/web`，`WEB_DIST_DIR`       |
| `http://localhost:8080/admin/` | `apps/admin/dist` → `/app/admin`，`ADMIN_DIST_DIR` |

```bash
docker compose --env-file .env -f deploy/compose.yaml up -d --build --wait
```

深层路由分别回退到各自的 index；不存在的 JS/CSS 与 API 继续返回 404，不返回另一端页面。`pnpm start` 同样托管两份产物；非 Docker 使用时，将 `APP_ORIGIN` 改为实际入口（例如 `http://localhost:3000`），未设置的 `ADMIN_APP_ORIGIN` 默认同源。

也可以独立构建与发布：

```bash
pnpm --filter @memory-weave/web... build
pnpm --filter @memory-weave/admin... build
```

聊天站点将 `apps/web/dist` 发布到 `/`，管理站点将 `apps/admin/dist` 发布到 `/admin/`，各自配置 SPA 回退并把本域 `/api` 代理到同一后端。管理端基路径固定 `/admin/`，不能把其产物直接放在另一个站点的根目录。HTTPS、SSE 无缓冲代理沿用 F06 部署说明。

独立域名时明确配置 `APP_ORIGIN`、`ADMIN_APP_ORIGIN`（Compose 为 `DEPLOY_APP_ORIGIN`、`DEPLOY_ADMIN_APP_ORIGIN`），两端使用相同 HTTP/HTTPS 安全协议；管理端构建时设置公开变量 `PUBLIC_CHAT_URL` 为聊天站点地址。该变量仅用于跳转，不能放密钥。默认 Docker 的两个入口同源，无需设置它；若自行制作跨域部署镜像，需在构建阶段显式传入公开地址，运行时环境不会改变已构建页面。

分项目不等于分权限：当前沿用单部署者密码与同一个后端认证。同源访问共用 Cookie，退出登录会撤销该服务端会话；不同域名通过各自同源 API 代理登录，不依赖跨站 Cookie。多用户角色与权限体系不在本次范围。

## 验收

1. 启动两端，聊天端首页为私聊；创建伴侣、开始聊天、刷新与断线重连可用。导航没有运行概览、模板、清理记录。
2. 聊天详情查看记忆与来源，没有手动整理或批次重试控件；删除消息后仍停留在本次私聊，另一窗口的旧正文同步失效。
3. 后台登录后查看真实 MySQL、Qdrant 与存储状态；伴侣列表为表格，可管理约束、历史版本、模板与实例生命周期。
4. 后台「记忆记录」选取私聊后查看整理批次、触发整理；侧栏、深层地址刷新和「打开聊天端」均落到正确项目。
5. 手机视口导航可操作，页面不横向溢出；生产 `/admin/companions` 与 `/chats/:id` 刷新不互串。

自动验收覆盖已有聊天/管理业务、双入口导航与刷新、消息删除后的双窗口失效、来源只读/管理整理、登录来源白名单以及两份静态产物的路由回退。质量与部署验证结果记录在 `docs/progress.md`。
