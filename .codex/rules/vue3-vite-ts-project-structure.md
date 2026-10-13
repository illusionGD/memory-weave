---
description: Vue 3 + Vite + TypeScript 项目目录、分层边界、命名与工程配置（由 vue3-vite-ts-project-structure skill 合并）
globs: src/**/*
alwaysApply: false
---

# Vue3 + Vite + TS 工程结构（Project Structure）

本规则由 `.cursor/skills/vue3-vite-ts-project-structure` 的 `references/` 合并而来；细则以 Skill 分文件为权威，本 Rule 便于 Cursor 按路径自动挂载。

**适用范围**：默认匹配 `src/**`；编辑根目录 `vite.config.ts`、`tsconfig*.json`、`.env*` 时同样遵循 **第 6 节**及分层原则。

**应用方式**：新建项目 / 增量重构 / 架构审查时，对照下列目录树与依赖方向；输出区分 **必须调整** / **建议优化** / **建议目录树**。

---

## 1. 标准目录结构

- 全局样式体系统一放在 `src/assets/styles`（如 `reset`、`tokens`、`theme`、`utilities`），入口多为 `index.scss` 并在 `main.ts` 引入。
- 组件 **局部样式** 写在组件内；**公共样式** 收敛到 `assets/styles`，避免散落。

### 推荐目录树（参考）

```txt
.
├─ public/
├─ src/
│  ├─ assets/
│  │  ├─ images/
│  │  ├─ icons/
│  │  ├─ fonts/
│  │  └─ styles/
│  │     ├─ reset.scss
│  │     ├─ tokens.scss
│  │     ├─ theme.scss
│  │     ├─ utilities.scss
│  │     └─ index.scss
│  ├─ components/
│  ├─ views/
│  ├─ router/
│  ├─ stores/
│  ├─ composables/
│  ├─ services/
│  ├─ utils/
│  ├─ types/
│  ├─ constants/
│  ├─ App.vue
│  └─ main.ts
├─ .env
├─ .env.development
├─ .env.production
├─ index.html
├─ tsconfig.json
├─ tsconfig.app.json
└─ vite.config.ts
```

可按业务增加 `features/<域>/` 等，但需保持 **第 2 节** 依赖方向。

---

## 2. 分层职责与依赖边界

| 目录 | 职责 |
|------|------|
| `views` | 页面装配，避免堆积复杂业务逻辑 |
| `components` | 通用 / 复用 UI |
| `stores` | Pinia 状态 |
| `services` | 接口访问与数据转换 |
| `utils` | 纯工具函数 |
| `types` | 公共类型与 `*.d.ts` |

**依赖方向（建议）**

- `views` → `components` / `stores` / `services`
- `components` → `composables` / `utils`；**不**直接依赖 `views`
- `utils` **不**依赖上层业务模块（views/stores 等）

---

## 3. Vue 专项目录约定

- **`components/`**：跨页面复用，文件名 **`PascalCase.vue`**。
- **`views/`**：路由页面；一页一目录或一个主文件。
- **`composables/`**：组合式逻辑，命名 **`useXxx.ts`**。
- **`stores/`**：Pinia，按业务域拆分文件（`kebab-case.ts` 等，见第 4 节）。

**补充**

- 页面私有组件优先 **`views/<page>/components/`**。
- 大型业务可在 **`features/<域>/`** 下按域拆分（内部仍遵守第 2 节边界）。

---

## 4. 命名与文件后缀

- **目录**：`kebab-case`
- **Vue 组件文件**：`PascalCase.vue`
- **TS 模块**（非组件）：`kebab-case.ts`
- **类型声明**：`*.d.ts`
- **composable**：`useXxx.ts`
- **常量标识符**：`UPPER_SNAKE_CASE`

---

## 5. Vite 与工程配置

- **`vite.config.ts`**：路径别名、构建、插件；保持单一入口、可读拆分（如有 `vite.config.*.ts` 需在团队内约定）。
- **`.env*`**：按环境拆分，敏感与公共变量不进仓库的按团队规范处理；业务代码避免硬编码环境值。
- **`tsconfig*.json`**：区分 **app** / **node**（如 `tsconfig.app.json`、`tsconfig.node.json`）职责清晰。
- **全局样式**：推荐在 `src/assets/styles/index.scss` 聚合，由 **`main.ts`** 单点引入。

---

## 6. 与 `frontend-code-standards` 的关系

- **代码风格、SFC、Pinia 写法**：见 `.cursor/rules/frontend-code-standards.mdc`。
- **本规则**侧重 **放哪、谁依赖谁、叫什么**；二者同时适用时以 **结构边界** + **风格规则** 一并检查。
