import { assertRestoreReady } from './database/archive-data';
import { acquireArchiveLock } from './database/archive-lock';
import { TaskWorkerService } from './modules/tasks/task-worker.service';
import { createApplication } from './app';
import { ConfigurationError, loadServerConfig } from './config';
import { createLogger } from './logging';

/**
 * 启动后端 HTTP 服务并监听配置端口。
 *
 * 根据部署环境配置启动 HTTP 服务并监听端口。
 */
async function bootstrap(): Promise<void> {
  const config = loadServerConfig(process.env);
  const logger = createLogger(config.logging);
  const lock = await acquireArchiveLock(config.databaseUrl);
  try {
    await assertRestoreReady(config.dataDir);
    const app = await createApplication(config, logger);
    app.enableShutdownHooks();
    lock.connection.on('error', () => {
      logger.fatal({ event: 'server.storage_lock.lost' }, '数据库独占连接丢失，后端已停止。');
      void app.close().finally(() => process.exit(1));
    });
    try {
      await app.listen(config.port, config.host);
      await app.get(TaskWorkerService).start();
      logger.info(
        { event: 'server.listening', host: config.host, port: config.port },
        '后端服务已启动。',
      );
    } catch (error) {
      await app.close();
      throw error;
    }
  } catch (error) {
    await lock.close().catch(() => undefined);
    throw error;
  }
}

void bootstrap().catch((error: unknown) => {
  createLogger({ level: 'error', format: 'json' }).fatal(
    { event: 'server.startup.failed', err: error },
    error instanceof ConfigurationError ? error.message : '后端服务启动失败。',
  );
  process.exitCode = 1;
});
