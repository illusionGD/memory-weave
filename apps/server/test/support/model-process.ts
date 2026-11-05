import { createApplication } from '../../src/app';
import { loadServerConfig } from './model-config';

/** 启动故障测试服务，通过 IPC 通知端口，避免日志被误认为就绪信号。 */
const app = await createApplication(loadServerConfig(process.env));
await app.listen(0, '127.0.0.1');
process.send!({ url: await app.getUrl() });
