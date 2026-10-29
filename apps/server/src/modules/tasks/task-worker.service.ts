import { ChatExecutionService } from '../chats/chat-execution.service';
import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { API_CODES } from '@memory-weave/contracts';
import { ApiException } from '../../http/api-exception';
import { ModelRuntimeService } from '../models/model-runtime.service';
import { TasksService } from './tasks.service';
import { TaskOutboxService } from './task-outbox.service';
import { TaskConfigurationService, defaultTaskConfiguration } from './task-configuration.service';
import type { TaskLease } from './task-types';
import { CompanionPersonasService } from '../companions/companion-personas.service';

/** 进程仅负责唤醒与执行，队列、租约、检查点和计量始终以数据库为准。 */
@Injectable()
export class TaskWorkerService implements OnModuleDestroy {
  private readonly active = new Set<Promise<void>>();
  private stopping: AbortController | null = null;
  private loop: Promise<void> | null = null;

  constructor(
    @Inject(ChatExecutionService) private readonly chats: ChatExecutionService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(TaskOutboxService) private readonly outbox: TaskOutboxService,
    @Inject(TaskConfigurationService) private readonly configuration: TaskConfigurationService,
    @Inject(ModelRuntimeService) private readonly models: ModelRuntimeService,
    @Inject(CompanionPersonasService) private readonly personas: CompanionPersonasService,
  ) {}

  /** 主进程监听后启动；测试或维护程序可以只创建 HTTP 应用而不自动消费。 */
  async start(): Promise<void> {
    if (this.loop) return;
    this.stopping = new AbortController();
    this.loop = this.schedule(this.stopping.signal);
  }

  /** 停止新领取，等待当前有界步骤完成；硬中断由租约和检查点恢复。 */
  async stop(): Promise<void> {
    this.stopping?.abort();
    await this.loop;
    await Promise.allSettled([...this.active]);
    this.loop = null;
    this.stopping = null;
  }

  /** 先停 worker 再关闭数据库连接池。 */
  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  private async schedule(signal: AbortSignal): Promise<void> {
    let pollMs = defaultTaskConfiguration.pollMs;
    while (!signal.aborted) {
      try {
        const current = await this.configuration.get();
        pollMs = current.config.pollMs;
        if (current.config.enabled) {
          await this.outbox.dispatch();
          while (!signal.aborted && this.active.size < current.config.maxConcurrent) {
            const lease = await this.tasks.claim();
            if (!lease) break;
            const execution = this.execute(lease);
            this.active.add(execution);
            void execution.then(
              () => this.active.delete(execution),
              () => this.active.delete(execution),
            );
          }
        }
      } catch {
        // 不打印连接串、任务正文或外部错误；持续失败会保留持久任务等待恢复。
        console.warn(JSON.stringify({ event: 'tasks.poll.unavailable' }));
      }
      try {
        await delay(pollMs, undefined, { signal });
      } catch {
        break;
      }
    }
  }

  private async execute(lease: TaskLease): Promise<void> {
    let heartbeatPending: Promise<void> | null = null;
    let leaseLost = false;
    const heartbeat = setInterval(
      () => {
        if (heartbeatPending || leaseLost) return;
        heartbeatPending = this.tasks
          .heartbeat(lease)
          .catch(() => {
            leaseLost = true;
          })
          .finally(() => {
            heartbeatPending = null;
          });
      },
      Math.floor(lease.config.leaseMs / 3),
    );
    heartbeat.unref();
    try {
      if (lease.input.kind === 'diagnostic') {
        for (
          let step = lease.task.progress.completedSteps + 1;
          step <= lease.input.steps;
          step += 1
        ) {
          if (leaseLost) return;
          await this.tasks.checkpoint(lease, { completedSteps: step, stage: 'steps' });
        }
        if (!leaseLost) await this.tasks.complete(lease);
      } else if (lease.input.kind === 'chat_reply') {
        await this.chats.execute(lease);
      } else if (lease.input.kind === 'persona_initialization') {
        await this.personas.execute(lease);
      } else if (lease.input.kind === 'model_probe') {
        let call = await this.models.probe(lease.input.probe, (ownerId, tx) =>
          this.tasks.guardDispatch(ownerId, tx, lease),
        );
        // 恢复时可能读到另一进程已发出的调用；只查询同一结果，不换键重发。
        while (call.status === 'running' && !leaseLost) {
          await delay(lease.config.pollMs);
          await this.tasks.heartbeat(lease);
          call = await this.models.get(call.id);
        }
        if (leaseLost) return;
        await this.tasks.checkpoint(lease, {
          completedSteps: call.status === 'succeeded' ? 1 : 0,
          stage: 'model_result',
          modelCallId: call.id,
        });
        if (call.status === 'succeeded') await this.tasks.complete(lease);
        else if (call.status === 'unknown') await this.tasks.block(lease, 'model_result_unknown');
        else
          await this.tasks.fail(
            lease,
            call.status === 'cancelled' ? 'model_cancelled' : 'model_failed',
          );
      } else {
        await this.tasks.block(lease, 'handler_unavailable');
      }
    } catch (error) {
      if (error instanceof ApiException && error.code === API_CODES.TASK_LEASE_LOST) return;
      try {
        await this.tasks.fail(
          lease,
          error instanceof ApiException ? `api_${error.code}` : 'handler_failed',
          error instanceof ApiException &&
            [
              API_CODES.MODEL_CAPACITY_EXCEEDED,
              API_CODES.MODEL_BUDGET_EXCEEDED,
              API_CODES.DATA_UNAVAILABLE,
            ].some((code) => code === error.code),
        );
      } catch {
        console.warn(JSON.stringify({ event: 'tasks.result.uncommitted', taskId: lease.task.id }));
      }
    } finally {
      clearInterval(heartbeat);
      await heartbeatPending;
    }
  }
}
