import { systemStatusSchema, type SystemStatus } from '@memory-weave/contracts';
import { requestJson } from './http';

/**
 * 查询当前部署的基础运行状态。
 * @returns 受认证保护的数据库与附件目录状态。
 */
export function getSystemStatus(): Promise<SystemStatus> {
  return requestJson('/api/system/status', systemStatusSchema);
}
