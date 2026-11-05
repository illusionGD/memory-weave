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
  const app = await createApplication(config, logger);
  app.enableShutdownHooks();
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
}

void bootstrap().catch((error: unknown) => {
  createLogger({ level: 'error', format: 'json' }).fatal(
    { event: 'server.startup.failed', err: error },
    error instanceof ConfigurationError ? error.message : '后端服务启动失败。',
  );
  process.exitCode = 1;
});
