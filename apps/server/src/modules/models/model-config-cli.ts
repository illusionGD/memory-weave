import { resolve } from 'node:path';
import { loadModelDeployment, ModelFileError } from './model-deployment';

/** 在启动服务前检查或查看所选 JSON，不访问数据库和供应商。 */
function main(): void {
  const [action = 'check', file] = process.argv.slice(2);
  if (!['check', 'show'].includes(action)) throw new ModelFileError('仅支持 check 或 show。');
  const deployment = loadModelDeployment({
    ...process.env,
    ...(file ? { MODEL_CONFIG_FILE: resolve(file) } : {}),
  });
  if (action === 'check') {
    console.log(
      JSON.stringify({
        file: deployment.file!.path,
        fingerprint: deployment.file!.fingerprint,
        valid: true,
      }),
    );
    return;
  }
  console.log(
    JSON.stringify(
      {
        providers: deployment.providers.map(({ apiKey: _secret, ...definition }) => definition),
        hardLimits: deployment.hardLimits,
        configuration: deployment.file!.configuration,
      },
      null,
      2,
    ),
  );
}
try {
  main();
} catch (error) {
  console.error(error instanceof ModelFileError ? error.message : '模型配置检查失败。');
  process.exitCode = 1;
}
