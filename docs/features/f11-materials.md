# F11 材料阅读

在私聊的输入区选择或拖入 JPEG、PNG、WebP、TXT、Markdown 或文字型 PDF，也可粘贴图片。可以只发材料。分享网页链接时，服务器登记一个独立的获取任务。卡片保留各次分享的版本、取得范围和时间，下载原件与查看片段需要登录。

## 阅读与来源

- 材料状态表示获取和提取的结果。聊天模型只使用本轮实际提供的页、段或图片观察。问 PDF 中的具体页码时，优先选择该页和附近文字。没有文字层的页会单独标明，图表可用截图补充。
- 图片概览有独立的感知模型用途。对于长图，可问顶部、底部或指定区域。明确纠正照片内容会保留原有分享，并把纠正关联到同会话的观察。感知结果是带不确定性的观察。
- 通过卡片的「总结全文文字」或在私聊明确提出全文总结，可以安排独立任务。进度显示确实覆盖的片段，后台分批结果可以暂停、恢复或取消。断线或继续聊天时，结果留在原卡片。没有实际取得或没有文字层的部分会标为部分结果。
- 普通图文、B站、知乎和公众号都沿用公开页面获取。B站视频页面仅使用实际取得的文字和封面，不读视频或字幕。验证、登录、网络限制或正文缺失时，卡片提示粘贴正文或上传正文文件、截图。再次分享链接创建新版本，之前的消息仍指向旧版本。
- 后台从记忆证据和来源原文查看材料版本、处理状态和片段。可采用的外部资料保留材料引用，照片描述标为观察。删除分享后旧材料无法再被该来源使用，只有最后一条有效分享失效时才回收原件。重置伴侣清理该代次的阅读记录，其他有效引用继续保留。

## 更新部署

两端与后端一起升级。当前 `0000_development_baseline` 的环境先停止旧后端，在 Node 22.20 或以上的 22.x 运行以下命令。

```bash
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm build
pm2 startOrRestart deploy/ecosystem.config.cjs --update-env
```

迁移 `0001_materials` 新增四张材料表并扩展证据定位字段。沿用原来的 MySQL、Redis、Qdrant 和 `DATA_DIR`。Compose 部署的应用数据卷同样需要持久保存。反向代理需要允许配置的上传大小。

`MATERIAL_CONFIG_JSON` 可覆盖 `maxAttachments`、`maxFileBytes`、`maxImagePixels`、`maxPdfPages`、`maxTextCharacters`、`maxWebBytes`、`webTimeoutMs`、`maxRedirects`、`maxWebImages`、`maxWebImageBytes`、`parseTimeoutMs`、`maxStorageBytes` 和 `minFreeBytes`。缺省每条至多 4 份附件，每份 20 MiB，单个 PDF 至多 100 页。未发送原件和中断后未发布的暂存文件保留约 24 小时。

正式配置的 `perception` 缺省停用。启用时，在模型配置 JSON 为它选择支持结构化输出与图像输入的供应商，并设置价格和额度。供应商的 `visionInputTokens` 取其按高细节、最长边 1600 像素单图输入计费的保守上界。部署者修改模型 JSON 后重启。开发配置的确定性模型可以验证链路，中文图片、小字和图表的识别效果需要在实际选择的模型上评估。

## 验收

```bash
pnpm verify:f11
pnpm test:e2e materials.spec.ts --project desktop --project mobile
```

定向验收需要隔离的 `TEST_DATABASE_URL` 与 `TEST_REDIS_URL`。浏览器和完整回归还使用 `TEST_QDRANT_URL` 与 `TEST_QDRANT_API_KEY`。用例创建临时数据库和文件目录，结束后清理。公开站点能力受文章和网络影响，站点样本记录见 [首次实测](../research/f11-materials-validation.md)。
