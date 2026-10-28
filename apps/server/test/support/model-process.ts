import { createApplication } from '../../src/app';
import { loadServerConfig } from '../../src/config';

/** 故障测试专用进程，监听随机本机端口；仅输出端口，不输出部署配置。 */
const app = await createApplication(loadServerConfig(process.env));
await app.listen(0, '127.0.0.1');
process.stdout.write(`${JSON.stringify({ url: await app.getUrl() })}\n`);
