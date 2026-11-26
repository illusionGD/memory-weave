import { Inject, Injectable } from '@nestjs/common';
import {
  chatConfigurationSchema,
  memoryConfigurationSchema,
  memoryMaintenanceConfigurationSchema,
  retrievalConfigurationSchema,
} from '@memory-weave/contracts';
import type { AdministrationConfiguration } from '@memory-weave/contracts';
import { SERVER_CONFIG } from '../../config';
import type { RuntimeConfig } from '../../config';
import { autonomyConfigurationSchema } from '../autonomy/autonomy-config';
import { growthConfigurationSchema } from '../growth/growth-config';
import { materialConfigurationSchema } from '../materials/material-config';
import { ModelConfigurationService } from '../models/model-configuration.service';
import { defaultModelConfiguration } from '../models/model-defaults';
import { peerConfigurationSchema } from '../peer-talk/peer-config';
import { reflectionConfigurationSchema } from '../reflections/reflection-config';
import { relationshipConfigurationSchema } from '../relationships/relationship-config';
import { fingerprint } from '../shared/http';
import {
  TaskConfigurationService,
  defaultTaskConfiguration,
} from '../tasks/task-configuration.service';
import { terminalConfigurationSchema } from '../terminals/terminal-config';

type Group = AdministrationConfiguration['groups'][number];

/** 汇总各模块共同采用的配置快照及其生效入口。 */
@Injectable()
export class AdministrationConfig {
  /** 注入已有配置来源，不单独存储预算或凭据。 */
  constructor(
    @Inject(SERVER_CONFIG) private readonly config: RuntimeConfig,
    @Inject(ModelConfigurationService) private readonly models: ModelConfigurationService,
    @Inject(TaskConfigurationService) private readonly tasks: TaskConfigurationService,
  ) {}

  /** 返回当前配置、默认来源和所属模块的修改方式。 */
  async read(ownerId: string): Promise<AdministrationConfiguration> {
    const [models, tasks] = await Promise.all([this.models.get(ownerId), this.tasks.get(ownerId)]);
    const config = this.config;
    return {
      groups: [
        {
          name: 'models',
          version: models.version,
          values: models.config,
          defaults: defaultModelConfiguration(),
          update: config.modelDeployment?.file ? 'file' : 'api',
          source: models.source,
          scope: 'deployment',
          endpoint: '/api/models/config',
        },
        {
          name: 'tasks',
          version: tasks.version,
          values: tasks.config,
          defaults: defaultTaskConfiguration,
          update: 'api',
          source: tasks.source,
          scope: 'deployment',
          endpoint: '/api/tasks/config',
        },
        deployed('chat', chatConfigurationSchema.parse({}), config.chatConfiguration),
        deployed('memory', memoryConfigurationSchema.parse({}), config.memoryConfiguration),
        deployed(
          'retrieval',
          retrievalConfigurationSchema.parse({}),
          config.retrievalConfiguration,
        ),
        deployed(
          'memoryMaintenance',
          memoryMaintenanceConfigurationSchema.parse({}),
          config.memoryMaintenanceConfiguration,
        ),
        deployed('materials', materialConfigurationSchema.parse({}), config.materialConfiguration),
        deployed('terminal', terminalConfigurationSchema.parse({}), config.terminalConfiguration),
        deployed(
          'relationships',
          relationshipConfigurationSchema.parse({}),
          config.relationshipConfiguration,
        ),
        deployed(
          'reflections',
          reflectionConfigurationSchema.parse({}),
          config.reflectionConfiguration,
        ),
        deployed('growth', growthConfigurationSchema.parse({}), config.growthConfiguration),
        deployed('autonomy', autonomyConfigurationSchema.parse({}), config.autonomyConfiguration),
        deployed('peerTalk', peerConfigurationSchema.parse({}), config.peerConfiguration),
        deployed(
          'lifecycle',
          { batchSize: 100 },
          config.lifecycleBatchSize === undefined
            ? undefined
            : { batchSize: config.lifecycleBatchSize },
        ),
      ],
      instanceOverrides: [
        { name: 'growth', endpoint: '/api/companions/:id/growth/control' },
        { name: 'autonomy', endpoint: '/api/companions/:id/autonomy' },
        { name: 'peerTalk', endpoint: '/api/companions/:id/peer-policy' },
        { name: 'peerRoom', endpoint: '/api/conversations/:id/peer-policy' },
        { name: 'embedding', endpoint: '/api/retrieval/embedding-spaces' },
      ],
    };
  }
}

/** 部署环境组用有效配置内容标识版本，重启值相同则身份不变。 */
function deployed(name: string, defaults: Group['values'], values?: Group['values']): Group {
  const effective = values ?? defaults;
  const version = fingerprint(effective);
  return {
    name,
    source: version === fingerprint(defaults) ? 'default' : 'deployment',
    version,
    values: effective,
    defaults,
    scope: 'deployment',
    update: 'environment',
    endpoint: null,
  };
}
