import { createApplication } from './app';
import { ConfigurationError, loadServerConfig } from './config';

/** Starts the production HTTP listener using deployment-supplied environment settings. */
async function bootstrap(): Promise<void> {
  const config = loadServerConfig(process.env);
  const app = await createApplication(config);
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
  console.info(JSON.stringify({ event: 'server.listening', port: config.port }));
}

void bootstrap().catch((error: unknown) => {
  console.error(error instanceof ConfigurationError ? error.message : 'Server startup failed.');
  process.exitCode = 1;
});
