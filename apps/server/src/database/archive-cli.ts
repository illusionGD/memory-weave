import { ConfigurationError, loadServerConfig } from '../config';
import { exportArchive, importArchive, inspectArchive } from './archive-data';
import { replayArchive } from './archive-replay';

/** 备份工具只在离线环境运行，打印不包含业务内容的操作结果。 */
async function run() {
  const [, , command, directory, ...extra] = process.argv;
  if (!directory || extra.length || !['export', 'inspect', 'restore'].includes(command ?? ''))
    throw new ConfigurationError('用法：pnpm data:archive export|inspect|restore <备份目录>');
  const config = command === 'inspect' ? null : loadServerConfig(process.env);
  const result =
    command === 'inspect'
      ? await inspectArchive(directory)
      : command === 'export'
        ? await exportArchive(config!, directory)
        : await importArchive(config!, directory, (manifest, records) =>
            replayArchive(config!, manifest.ownerId, records),
          );
  process.stdout.write(
    JSON.stringify({
      command,
      schema: result.schema,
      createdAt: result.createdAt,
      rows: result.tables.reduce((count, table) => count + table.rows, 0),
      files: result.files.length,
    }) + '\n',
  );
}

void run().catch((error: unknown) => {
  const message =
    error instanceof Error && /^[\u4e00-\u9fff]/.test(error.message)
      ? error.message
      : '操作失败，检查目标版本、文件校验、存储权限和独立日志。';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
