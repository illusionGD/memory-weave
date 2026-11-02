import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { createClient } = require('redis');

/** 清理本轮浏览器验收的 Redis 前缀，不触碰其他测试或部署会话。 */
export default async function cleanupBrowserSessions() {
  const namespace = process.env.MEMORY_WEAVE_E2E_REDIS_NAMESPACE;
  if (!/^memory-weave:e2e:[a-f0-9]{24}$/.test(namespace ?? '')) {
    throw new Error('缺少有效的浏览器测试 Redis 隔离前缀。');
  }
  if (!process.env.TEST_REDIS_URL) throw new Error('缺少独立的 TEST_REDIS_URL。');
  const client = createClient({
    url: process.env.TEST_REDIS_URL,
    socket: { connectTimeout: 2000, socketTimeout: 2000, reconnectStrategy: false },
    disableOfflineQueue: true,
    commandOptions: { timeout: 2000 },
  });
  // 客户端原始错误可能包含服务信息；失败统一在调用方报告受控提示。
  client.on('error', () => {});
  try {
    await client.connect();
    let cursor = '0';
    do {
      const page = await client.scan(cursor, { MATCH: `${namespace}:*`, COUNT: 100 });
      cursor = page.cursor;
      if (page.keys.length) await client.unlink(page.keys);
    } while (cursor !== '0');
  } catch {
    throw new Error('未能清理本轮 Redis 测试前缀，请检查测试 Redis 是否可连接。');
  } finally {
    if (client.isOpen) client.destroy();
  }
}
