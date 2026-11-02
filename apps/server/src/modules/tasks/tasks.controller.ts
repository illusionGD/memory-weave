import { Body, Controller, Get, Inject, Param, Post, Query, Put, HttpCode } from '@nestjs/common';
import {
  emptyCommandSchema,
  versionParamSchema,
  uuidSchema,
  diagnosticTaskSchema,
  queuedModelProbeSchema,
  taskListQuerySchema,
  updateTaskConfigurationSchema,
  idPaginationQuerySchema,
} from '@memory-weave/contracts';
import type {
  EmptyCommand,
  DiagnosticTask,
  QueuedModelProbe,
  TaskListQuery,
  IdPaginationQuery,
  UpdateTaskConfiguration,
} from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { TaskOutboxService } from './task-outbox.service';
import { TaskConfigurationService } from './task-configuration.service';
import { TasksService } from './tasks.service';

/** 已认证管理者的任务诊断入口；不向终端提供领取和提交令牌。 */
@Controller('tasks')
export class TasksController {
  /** 初始化任务管理接口所需的服务。 */
  constructor(
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(TaskConfigurationService) private readonly configuration: TaskConfigurationService,
    @Inject(TaskOutboxService) private readonly outbox: TaskOutboxService,
  ) {}

  /**
   * 创建确定性诊断任务。
   *
   * 创建不会修改伴侣状态的确定性诊断。
   */
  @Post('diagnostics')
  createDiagnostic(@Body(new ZodValidationPipe(diagnosticTaskSchema)) body: DiagnosticTask) {
    return this.tasks.createDiagnostic(body);
  }

  /**
   * 创建后台模型诊断任务。
   *
   * 创建后台模型诊断，保持 F03 的配置版本及预算检查。
   */
  @Post('model-probes')
  createModelProbe(@Body(new ZodValidationPipe(queuedModelProbeSchema)) body: QueuedModelProbe) {
    return this.tasks.createModelProbe(body);
  }

  /** 分页查询当前部署的任务。 */
  @Get()
  list(@Query(new ZodValidationPipe(taskListQuerySchema)) query: TaskListQuery) {
    return this.tasks.list(query);
  }

  /** 分页查询待办事件的转交进度。 */
  @Get('outbox')
  listOutbox(@Query(new ZodValidationPipe(idPaginationQuerySchema)) query: IdPaginationQuery) {
    return this.outbox.list(query);
  }

  /** 查询当前任务调度配置。 */
  @Get('config')
  config() {
    return this.configuration.get();
  }

  /**
   * 发布新的任务调度配置。
   *
   * 发布不可变新版本。
   */
  @Put('config')
  updateConfig(
    @Body(new ZodValidationPipe(updateTaskConfigurationSchema)) body: UpdateTaskConfiguration,
  ) {
    return this.configuration.update(body);
  }

  /** 查询指定版本的任务调度配置。 */
  @Get('config/versions/:version')
  configVersion(@Param('version', new ZodValidationPipe(versionParamSchema)) version: number) {
    return this.configuration.getVersion(version);
  }

  /**
   * 暂停指定任务。
   *
   * 暂停后保持检查点，旧执行者不能继续提交。
   */
  @Post(':id/pause')
  @HttpCode(200)
  pause(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(emptyCommandSchema)) _body: EmptyCommand,
  ) {
    return this.tasks.control(id, 'pause');
  }

  /**
   * 恢复指定任务。
   *
   * 从已保存步骤继续，累计尝试次数保持不变。
   */
  @Post(':id/resume')
  @HttpCode(200)
  resume(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(emptyCommandSchema)) _body: EmptyCommand,
  ) {
    return this.tasks.control(id, 'resume');
  }

  /**
   * 取消指定任务。
   *
   * 取消只停止后续提交，不能宣称撤销外部效果。
   */
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(emptyCommandSchema)) _body: EmptyCommand,
  ) {
    return this.tasks.control(id, 'cancel');
  }

  /** 查询任务详情和当前进度。 */
  @Get(':id')
  get(@Param('id', new ZodValidationPipe(uuidSchema)) id: string) {
    return this.tasks.get(id);
  }
}
