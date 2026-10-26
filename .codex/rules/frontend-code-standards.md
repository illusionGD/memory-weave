---
description: Vue 3、TypeScript、Pinia、样式、注释与格式化规范
globs: src/**/*.{vue,ts,tsx,scss,css}
alwaysApply: true
---

# 前端代码规范

本规则约束 `src` 下的 Vue、TypeScript 和样式代码。目录职责、依赖方向与文件命名见 `vue3-vite-ts-project-structure.mdc`。

## 1. Vue SFC

固定顺序：

```vue
<template>
  <!-- 声明式结构 -->
</template>

<script setup lang="ts">
// 状态与逻辑
</script>

<style scoped lang="scss">
/* 组件样式 */
</style>
```

- 单组件单职责；页面装配与业务组件分开，复杂业务逻辑抽到 composable 或 store。
- `template` 只负责结构和绑定；复杂判断放到 `computed` 或命名方法。
- `v-for` 使用稳定的 `:key`，不要长期使用 `index`。
- 事件绑定使用命名方法，避免在模板中写复杂逻辑。
- 交互元素优先使用语义标签，并提供必要的无障碍属性。

### `script setup`

推荐顺序：`import` → `type/interface` → store → props → emits → 状态 → computed → 常量 → 生命周期 → 方法。

- Props 必须显式定义类型；可选项在无特殊语义时提供默认值。
- Emits 必须显式声明事件名和参数类型。
- Vue 文件可使用 `// #region name` 分组；`.ts` 文件不使用 `#region`。
- 组件方法、事件处理和复杂计算应有说明，优先抽取可复用逻辑。
- `watch` 只用于副作用，不替代 `computed`；异步逻辑必须反馈 loading/error。

## 2. Pinia Setup Store

- 使用 `defineStore('name', () => {})`，清晰区分 state、computed getters 和 actions。
- store 方法使用 `function` 声明；回调和局部函数可使用箭头函数。
- 异步 action 必须处理异常，并更新 loading/error 等状态。
- 外部通过 action 修改状态，不直接改写 store 内部数据。
- 对外可调用的方法使用 JSDoc，说明参数和非 `void` 返回值。

## 3. TypeScript

- 对外 API、函数入参和返回值显式声明类型；外部输入使用 `unknown` 后再收窄。
- 源码中指向 TypeScript 模块的 import / export 省略扩展名，不写成 `.js`；Vue 组件与其他真实资源保留其扩展名。
- 少用 `any`，统一空值策略，不混用 `null` 和 `undefined`。
- 顶层函数使用 `function` 声明；回调、局部函数和工厂内部函数可使用箭头函数。
- 公共类型放在 `src/types`，声明文件使用 `.d.ts`。
- 常量对象使用 `as const`，常量命名用 `UPPER_SNAKE_CASE`；函数用 camelCase，类型用 PascalCase。
- `interface`、`type` 字段和导出的常量说明其语义；方法之间、变量与方法之间保留适当空行。
- `*.ts` 不使用 `#region`。

## 4. 注释

以下内容必须使用 `/** ... */`：导出函数、公共 API、工具函数、store action 和复杂业务函数。

- 说明「为什么、约束和边界」，不要复述代码字面含义。
- `@param` 每个参数单独一行；非 `void` 函数写 `@returns`，并与参数说明分行。
- 简单分支可使用一句行内注释；不要用注释替代清晰命名或拆分函数。

## 5. 样式

- 组件样式默认使用 `<style scoped lang="scss">`；全局样式集中在 `src/assets/styles`。
- 类名使用 BEM，如 `.block__element--modifier`；状态使用 `.is-active`、`.is-disabled`。
- 嵌套不超过 3 层，避免过高权重选择器和无语义类名。
- 颜色、间距、圆角等优先使用全局 tokens；重复样式达到 3 处时抽取公共类、变量或 mixin。

## 6. 格式化与检查

每次修改后运行：

```bash
pnpm exec prettier --write <changed-files>
pnpm lint
pnpm typecheck
```

- 项目使用 Prettier，配置见 `.prettierrc.json`。
- 必须修复缩进、引号、行尾空格、尾逗号等格式问题。
- 格式化只处理代码排版；注释内容、命名和逻辑结构按本规则人工审查。
