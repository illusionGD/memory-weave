import { Body, Controller, Get, Inject, Param, Post, Query, Put, HttpCode } from '@nestjs/common';
import {
  diagnosticTaskSchema,
  queuedModelProbeSchema,
  taskListQuerySchema,
  updateTaskConfigurationSchema,
  positiveIntegerSchema,
  idPaginationQuerySchema,
} from '@memory-weave/contracts';
import { parseId, parseInput } from '../shared/http';
import { TaskOutboxService } from './task-outbox.service';
import { z } from 'zod';
import { TaskConfigurationService } from './task-configuration.service';
import { TasksService } from './tasks.service';

/** 已认证管理者的任务诊断入口；不向终端提供领取和提交令牌。 */
@Controller('tasks')
export class TasksController {
  constructor(
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(TaskConfigurationService) private readonly configuration: TaskConfigurationService,
    @Inject(TaskOutboxService) private readonly outbox: TaskOutboxService,
  ) {}

  /** 创建不会修改伴侣状态的确定性诊断。 */
  @Post('diagnostics')
  createDiagnostic(@Body() body: unknown) {
    return this.tasks.createDiagnostic(parseInput(diagnosticTaskSchema, body));
  }

  /** 创建后台模型诊断，保持 F03 的配置版本及预算检查。 */
  @Post('model-probes')
  createModelProbe(@Body() body: unknown) {
    return this.tasks.createModelProbe(parseInput(queuedModelProbeSchema, body));
  }

  /** 分页查询本部署的任务。 */
  @Get()
  list(@Query() query: unknown) {
    return this.tasks.list(parseInput(taskListQuerySchema, query));
  }

  /** outbox 转交进度，与任务处理进度分别显示。 */
  @Get('outbox')
  listOutbox(@Query() query: unknown) {
    return this.outbox.list(parseInput(idPaginationQuerySchema, query));
  }

  /** 当前完整调度配置。 */
  @Get('config')
  config() {
    return this.configuration.get();
  }

  /** 发布不可变新版本。 */
  @Put('config')
  updateConfig(@Body() body: unknown) {
    return this.configuration.update(parseInput(updateTaskConfigurationSchema, body));
  }

  /** 查询历史配置。 */
  @Get('config/versions/:version')
  configVersion(@Param('version') version: string) {
    return this.configuration.getVersion(
      parseInput(
        z
          .string()
          .regex(/^[1-9]\d*$/)
          .transform(Number)
          .pipe(positiveIntegerSchema),
        version,
      ),
    );
  }

  /** 暂停后保持检查点，旧执行者不能继续提交。 */
  @Post(':id/pause')
  @HttpCode(200)
  pause(@Param('id') id: string, @Body() body: unknown) {
    parseInput(z.object({}).strict(), body ?? {});
    return this.tasks.control(parseId(id), 'pause');
  }

  /** 从已保存步骤继续，累计尝试次数保持不变。 */
  @Post(':id/resume')
  @HttpCode(200)
  resume(@Param('id') id: string, @Body() body: unknown) {
    parseInput(z.object({}).strict(), body ?? {});
    return this.tasks.control(parseId(id), 'resume');
  }

  /** 取消只停止后续提交，不能宣称撤销外部效果。 */
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string, @Body() body: unknown) {
    parseInput(z.object({}).strict(), body ?? {});
    return this.tasks.control(parseId(id), 'cancel');
  }

  /** 返回持久进度与受控原因。 */
  @Get(':id')
  get(@Param('id') id: string) {
    return this.tasks.get(parseId(id));
  }
}
