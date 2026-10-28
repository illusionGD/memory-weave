import { createApplication } from '../../src/app';
import { loadServerConfig } from '../../src/config';
import { TasksService } from '../../src/modules/tasks/tasks.service';
import { TaskWorkerService } from '../../src/modules/tasks/task-worker.service';

/** 故障注入只控制本测试创建的进程，通过公开任务接口保存步骤。 */
const app = await createApplication(loadServerConfig(process.env));
await app.listen(0, '127.0.0.1');
if (process.env.TASK_TEST_MODE === 'checkpoint') {
  const tasks = app.get(TasksService);
  const lease = await tasks.claim();
  if (!lease) throw new Error('没有可领取的测试任务。');
  await tasks.checkpoint(lease, { completedSteps: 1, stage: 'steps' });
  process.stdout.write(`${JSON.stringify({ taskId: lease.task.id, checkpoint: 1 })}\n`);
} else {
  await app.get(TaskWorkerService).start();
  process.stdout.write(`${JSON.stringify({ url: await app.getUrl() })}\n`);
}
