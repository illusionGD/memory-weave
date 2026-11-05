// 统一复用浏览器启动器，为记忆图谱场景创建独立配置与数据库。
process.argv.splice(2, 0, 'memory-explorer.spec.ts');
await import('./run-browser-e2e');
export {};
