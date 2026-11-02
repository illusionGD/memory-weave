import { connect, createServer } from 'node:net';
import type { Socket } from 'node:net';

/**
 * 通过真实 TCP 转发控制 Redis 可达性，保留实际协议和认证行为。
 * @param redisUrl 本地隔离 Redis 的真实连接地址。
 * @returns 转发连接地址与断开、阻塞、恢复和释放操作。
 */
export async function createRedisFaultProxy(redisUrl: string): Promise<{
  url: string;
  disconnect: () => void;
  stall: () => void;
  reconnect: () => void;
  close: () => Promise<void>;
}> {
  const target = new URL(redisUrl);
  if (target.protocol !== 'redis:') throw new Error('断线验收需要本地 redis:// 测试地址。');
  let mode: 'forward' | 'reject' | 'stall' = 'forward';
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (mode === 'reject') return socket.destroy();
    if (mode === 'stall') {
      sockets.add(socket);
      socket.on('error', () => socket.destroy());
      socket.on('close', () => sockets.delete(socket));
      return;
    }
    const upstream = connect({ host: target.hostname, port: Number(target.port || 6379) });
    for (const connection of [socket, upstream]) {
      sockets.add(connection);
      connection.on('error', () => {
        socket.destroy();
        upstream.destroy();
      });
      connection.on('close', () => {
        sockets.delete(connection);
        socket.destroy();
        upstream.destroy();
      });
    }
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试转发器未监听。');
  const proxy = new URL(redisUrl);
  proxy.hostname = '127.0.0.1';
  proxy.port = String(address.port);
  return {
    url: proxy.toString(),
    /** 断开已有连接并拒绝新连接，模拟 Redis 暂时不可用。 */
    disconnect() {
      mode = 'reject';
      for (const socket of sockets) socket.destroy();
    },
    /** 接受 TCP 连接但不响应 Redis 握手，验证连接总超时。 */
    stall() {
      mode = 'stall';
      for (const socket of sockets) socket.destroy();
    },
    /** 恢复实际 Redis 转发，后续请求可以重新建立认证连接。 */
    reconnect() {
      mode = 'forward';
    },
    /** 释放测试转发器和全部连接，不修改 Redis 数据。 */
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
