import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadServerConfig } from '../src/config';
import { defaultModelConfiguration } from '../src/modules/models/model-defaults';
import { defaultModelHardLimits } from '../src/modules/models/model-deployment';

const directories: string[] = [];
const environment = {
  REDIS_URL: 'redis://localhost:6379',
  REDIS_NAMESPACE: 'model-files',
  AUTH_SESSION_SECRET: 'a'.repeat(64),
  ADMIN_PASSWORD: 'model-file-test-password',
  DATABASE_URL: 'mysql://test:test@localhost/test',
  QDRANT_API_KEY: 'test-vector-key',
};
/** 创建本用例独占的模型配置文件。 */
function fixture(value: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'mw-model-file-'));
  directories.push(directory);
  const file = join(directory, 'models.json');
  writeFileSync(file, JSON.stringify(value));
  return file;
}
/** 创建显式的测试模型配置，不读取开发者文件。 */
function document() {
  return {
    providers: [],
    hardLimits: defaultModelHardLimits(),
    configuration: defaultModelConfiguration(),
  };
}
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })),
);

it('从指定 JSON 加载各用途模型与预算，拒绝旧环境变量覆盖文件', () => {
  const value = document();
  value.configuration.tasks.chat.maxOutputTokens = 800;
  const MODEL_CONFIG_FILE = fixture(value);
  const config = loadServerConfig({ ...environment, MODEL_CONFIG_FILE });
  expect(config.modelDeployment?.file?.configuration.tasks.chat.maxOutputTokens).toBe(800);
  expect(() =>
    loadServerConfig({ ...environment, MODEL_CONFIG_FILE, MODEL_PROVIDERS_JSON: '[]' }),
  ).toThrow('MODEL_PROVIDERS_JSON');
});

it('无效文件、字段、任务关系和密钥配置在启动前失败且不回显秘密', () => {
  const variants: unknown[] = [
    { ...document(), secret: 'private-value' },
    { ...document(), configuration: { ...document().configuration, maxConcurrent: 99 } },
  ];
  const wrongDefinition = document();
  wrongDefinition.configuration.tasks.chat.promptVersion = 'private-value';
  variants.push(wrongDefinition);
  const wrongDimensions = document();
  wrongDimensions.configuration.tasks.embedding.dimensions = null;
  variants.push(wrongDimensions);
  for (const value of variants) {
    try {
      loadServerConfig({ ...environment, MODEL_CONFIG_FILE: fixture(value) });
      expect.fail('应拒绝非法模型文件');
    } catch (error) {
      expect((error as Error).message).toContain('模型部署配置无效');
      expect((error as Error).message).not.toContain('private-value');
    }
  }
  const file = fixture(document());
  writeFileSync(file, '{private-value');
  expect(() => loadServerConfig({ ...environment, MODEL_CONFIG_FILE: file })).toThrow('有效 JSON');
  rmSync(file);
  expect(() => loadServerConfig({ ...environment, MODEL_CONFIG_FILE: file })).toThrow('文件缺失');
  expect(() => loadServerConfig({ ...environment, MODEL_CONFIG_FILE: 'relative.json' })).toThrow(
    '绝对路径',
  );
});

it('启用真实模型必须有能力、价格和凭据，密钥值不进入配置指纹', () => {
  const config = document();
  Object.assign(config.configuration.tasks.chat, {
    providerId: 'fixture',
    inputMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
  });
  const value = {
    ...config,
    providers: [
      {
        id: 'fixture',
        baseUrl: 'http://localhost:11434/v1',
        apiKeyEnv: 'MODEL_FIXTURE_KEY',
        capabilities: ['text'],
      },
    ],
  };
  const MODEL_CONFIG_FILE = fixture(value);
  expect(() => loadServerConfig({ ...environment, MODEL_CONFIG_FILE })).toThrow('缺少供应商凭据');
  const first = loadServerConfig({
    ...environment,
    MODEL_CONFIG_FILE,
    MODEL_FIXTURE_KEY: 'private-first',
  });
  const next = loadServerConfig({
    ...environment,
    MODEL_CONFIG_FILE,
    MODEL_FIXTURE_KEY: 'private-second',
  });
  expect(first.modelDeployment?.file?.fingerprint).toBe(next.modelDeployment?.file?.fingerprint);
  expect(JSON.stringify(first.modelDeployment?.file)).not.toContain('private-first');
  value.providers[0]!.capabilities = ['embedding'];
  writeFileSync(MODEL_CONFIG_FILE, JSON.stringify(value));
  expect(() =>
    loadServerConfig({ ...environment, MODEL_CONFIG_FILE, MODEL_FIXTURE_KEY: 'private-first' }),
  ).toThrow('能力不匹配');
});
