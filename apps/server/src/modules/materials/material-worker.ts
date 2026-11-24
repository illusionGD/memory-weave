import { parentPort, workerData } from 'node:worker_threads';
import { DocumentParseError } from './document-parser';
import type { MaterialConfiguration } from './material-config';
import { runMaterialOperation } from './material-operations';
import type { MaterialOperation } from './material-operations';

const input = workerData as { operation: MaterialOperation; limits: MaterialConfiguration };
try {
  parentPort!.postMessage({ result: await runMaterialOperation(input.operation, input.limits) });
} catch (error) {
  parentPort!.postMessage({
    reason: error instanceof DocumentParseError ? error.reason : 'invalid-format',
  });
}
