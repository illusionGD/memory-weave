import { defineConfig } from 'drizzle-kit';

/** 只生成需要审查并提交的 SQL；部署统一通过受控迁移入口执行。 */
export default defineConfig({
  dialect: 'mysql',
  schema: './src/database/schema.ts',
  out: './drizzle-mysql',
  strict: true,
});
