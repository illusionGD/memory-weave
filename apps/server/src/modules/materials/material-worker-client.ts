import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import type { MaterialConfiguration } from './material-config';
import type { MaterialOperation, MaterialOperationResult } from './material-operations';

export class MaterialWorkerError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** 启动单次可终止提取。调用方控制并发与持久任务租约。 */
export function extractMaterial(
  operation: MaterialOperation,
  limits: MaterialConfiguration,
): Promise<MaterialOperationResult> {
  // Nest 使用额外 Webpack 入口，源码测试通过 tsx 启动同一 worker。
  const entry = process.env.MEMORY_WEAVE_MATERIAL_WORKER_PATH;
  const source = !entry && import.meta.url.endsWith('.ts');
  const script =
    entry ?? new URL(source ? './material-worker.ts' : './material-worker.js', import.meta.url);
  const worker = new Worker(script, {
    workerData: { operation, limits },
    execArgv: source ? ['--import', createRequire(import.meta.url).resolve('tsx')] : [],
    resourceLimits: { maxOldGenerationSizeMb: 256 },
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new MaterialWorkerError('extraction-timeout'));
      void worker.terminate();
    }, limits.parseTimeoutMs);
    worker.once('message', (value: { result?: MaterialOperationResult; reason?: string }) => {
      clearTimeout(timeout);
      if (value.result) resolve(value.result);
      else reject(new MaterialWorkerError(value.reason ?? 'extraction-failed'));
      void worker.terminate();
    });
    worker.once('error', () => {
      clearTimeout(timeout);
      reject(new MaterialWorkerError('extraction-failed'));
    });
    worker.once('exit', () => {
      clearTimeout(timeout);
      reject(new MaterialWorkerError('extraction-interrupted'));
    });
  });
}
