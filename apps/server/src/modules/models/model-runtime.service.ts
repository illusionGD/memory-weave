import { DatabaseService } from '../../database/database.service';
import {
  MODEL_PROBE_DEFINITION_VERSION,
  MODEL_VECTOR_SCHEMA_VERSION,
  MODEL_PREPROCESSING_VERSION,
} from './model-constants';
import type {
  DailyModelBudget,
  ModelAttempt,
  ModelCall,
  ModelCallContext,
  ModelConfigurationVersion,
  ModelProbe,
  ModelResult,
  ModelTaskConfig,
  ModelUsage,
} from '@memory-weave/contracts';
import {
  API_CODES,
  MODEL_TASK_ROLES,
  modelCallContextSchema,
  modelDiagnosticValueSchema,
  modelProbeSchema,
  modelResultSchema,
} from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, lte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { DatabaseTransaction } from '../../database/database.service';
import { modelAttempts, modelCalls, modelUsageWindows } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import {
  requireCompanion,
  requireCompanionMember,
  requireConversation,
} from '../conversations/conversation-access';
import { fingerprint } from '../shared/http';
import type { ModelAdapterResponse } from './model-adapter';
import { ModelConfigurationService } from './model-configuration.service';
import { ModelProvidersService } from './model-providers.service';
import type {
  ModelDispatchGuard,
  ModelTaskDefinition,
  ModelTaskScope,
  ModelTextSink,
} from './model-task';
import { ModelProviderError } from './openai-compatible.adapter';

type AttemptRow = typeof modelAttempts.$inferSelect;
type CallRow = typeof modelCalls.$inferSelect;

/** 短事务预留与结算、事务外调用；模型完成不等于业务状态已采用。 */
@Injectable()
export class ModelRuntimeService {
  private readonly cancellations = new Map<string, AbortController>();
  /** 初始化模型调用和用量管理服务。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ModelConfigurationService) private readonly configuration: ModelConfigurationService,
    @Inject(ModelProvidersService) private readonly providers: ModelProvidersService,
  ) {}

  /**
   * 执行模型诊断请求。
   *
   * 使用当前部署配置进行隔离诊断；同键重试返回同一调用，不重发未知请求。
   * @param input 已通过公共契约校验的诊断命令。
   * @param guard 后台模块提供的派发前租约检查，不参与模型调用身份。
   * @returns 持久调用及尝试记录；失败结果仅含受控原因。
   */
  probe(ownerId: string, input: ModelProbe, guard?: ModelDispatchGuard): Promise<ModelCall> {
    return this.invoke(
      ownerId,
      input,
      {
        promptVersion: MODEL_PROBE_DEFINITION_VERSION,
        schemaVersion:
          input.operation === 'embedding'
            ? MODEL_VECTOR_SCHEMA_VERSION
            : MODEL_PROBE_DEFINITION_VERSION,
        preprocessingVersion: MODEL_PREPROCESSING_VERSION,
        systemPrompt:
          input.operation === 'structured'
            ? '这是隔离的模型接口诊断。请返回 JSON 对象，只包含 ok（布尔值）和 reply（非空字符串），不要输出额外字段。'
            : '这是隔离的模型接口诊断。请直接用文本回复，不执行工具或业务操作。',
        outputSchema: modelDiagnosticValueSchema,
      },
      { companionId: null, runtimeEpoch: null, conversationId: null },
      'diagnostic',
      guard,
    );
  }

  /**
   * 执行业务模块的模型请求并校验候选结果。
   *
   * 领域模块复用的统一入口，返回经过模块 schema 校验的候选，不自动写业务状态。
   * @param command 调用身份、输入和预期配置。
   * @param definition 领域模块拥有的提示词、版本及输出规范。
   * @param scope 实际关联实例及会话；统一入口在发送和采用候选前检查。
   * @param guard 在派发事务内验证任务是否仍有效；不能执行外部操作。
   * @returns 持久候选与诊断，后续业务提交仍须校验版本及生命周期。
   */
  execute(
    ownerId: string,
    command: ModelProbe,
    definition: ModelTaskDefinition,
    scope: ModelTaskScope = { companionId: null, runtimeEpoch: null, conversationId: null },
    guard?: ModelDispatchGuard,
  ): Promise<ModelCall> {
    return this.invoke(ownerId, command, definition, scope, 'task', guard);
  }

  /**
   * 执行流式模型请求并交付文本增量。
   *
   * 流式业务入口仍使用同一调用身份和预算；重放只返回持久结果，不再次发送增量。
   * @param command 文本调用及预期配置。
   * @param definition 服务端拥有的提示词与版本。
   * @param onText 接收候选增量，发布是否仍有效由领域模块检查。
   * @param scope 当前实例和会话范围。
   * @param guard 派发前的租约校验。
   * @returns 持久结果及真实尝试；中断不自动重发已经输出的回复。
   */
  executeStreaming(
    ownerId: string,
    command: ModelProbe,
    definition: ModelTaskDefinition,
    onText: ModelTextSink,
    scope: ModelTaskScope = { companionId: null, runtimeEpoch: null, conversationId: null },
    guard?: ModelDispatchGuard,
  ): Promise<ModelCall> {
    if (command.operation !== 'text') throw new ApiException(API_CODES.INVALID_REQUEST);
    return this.invoke(ownerId, command, definition, scope, 'task', guard, onText);
  }

  /**
   * 执行模型调用的预算预留、请求和结果结算。
   *
   * 两类入口共享同一配置、计量和幂等实现，诊断不能冒充真实经历。
   */
  private async invoke(
    ownerId: string,
    command: ModelProbe,
    definition: ModelTaskDefinition,
    scope: ModelTaskScope,
    kind: ModelCallContext['kind'],
    guard?: ModelDispatchGuard,
    onText?: ModelTextSink,
  ): Promise<ModelCall> {
    const inputResult = (
      kind === 'task'
        ? modelProbeSchema.extend({ inputText: z.string().min(1).max(65536) })
        : modelProbeSchema
    ).safeParse(command);
    const contextResult = modelCallContextSchema.safeParse({
      ...scope,
      kind,
      promptVersion: definition.promptVersion,
      schemaVersion: definition.schemaVersion,
      preprocessingVersion: definition.preprocessingVersion,
    });
    const promptResult = z.string().max(4000).safeParse(definition.systemPrompt);
    if (!inputResult.success || !contextResult.success || !promptResult.success)
      throw new ApiException(API_CODES.INVALID_REQUEST);
    const input = inputResult.data;
    const context = contextResult.data;
    const outputJsonSchema = outputSpecification(definition, input.operation);
    const hash = fingerprint({
      ...input,
      requestId: input.requestId.toLowerCase(),
      context,
      systemPrompt: definition.systemPrompt,
      outputJsonSchema,
      ...(onText ? { streaming: true } : {}),
    });
    const prepared = await this.configuration.locked(ownerId, async (tx, current) => {
      await guard?.(ownerId, tx);
      await expireAttempts(this.database, ownerId, tx);
      await assertScope(this.database, ownerId, tx, context);
      const existing = await this.database.modelCalls.findOne(
        ownerId,
        { where: { requestId: input.requestId } },
        tx,
      );
      if (existing) {
        if (existing.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return { callId: existing.id, task: null, attempt: null };
      }
      if (current.version !== input.expectedConfigVersion)
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      const task = current.config.tasks[input.role];
      assertRunnable(input, task, definition);
      if (
        kind === 'task' &&
        (task.promptVersion !== definition.promptVersion ||
          task.schemaVersion !== definition.schemaVersion ||
          task.preprocessingVersion !== definition.preprocessingVersion)
      )
        throw new ApiException(API_CODES.MODEL_NOT_CONFIGURED, '任务定义版本与有效配置不一致。');
      this.providers.adapter(task.providerId, input.operation);
      const call: CallRow = {
        id: randomUUID(),
        ownerId,
        requestId: input.requestId,
        context,
        fingerprint: hash,
        configId: current.id,
        configVersion: current.version,
        role: input.role,
        operation: input.operation,
        lane: input.lane,
        providerId: task.providerId,
        model: task.model,
        status: 'running',
        errorCode: null,
        result: null,
        invalidatedAt: null,
        createdAt: new Date(),
        finishedAt: null,
      };
      await tx.insert(modelCalls).values(call);
      const attempt = await reserveAttempt(
        this.database,
        ownerId,
        tx,
        { ...current, config: this.providers.effective(current.config) },
        call,
        task,
        input.inputText,
        1,
        definition,
      );
      return { callId: call.id, task, attempt };
    });
    if (prepared.task && prepared.attempt) {
      const task = prepared.task;
      let attempt: AttemptRow | null = prepared.attempt;
      const cancellation = new AbortController();
      this.cancellations.set(prepared.callId, cancellation);
      try {
        while (attempt) {
          let response: ModelAdapterResponse | null = null;
          let failure: ModelProviderError | null = null;
          try {
            if (attempt.number > 1)
              await delay(task.retryDelayMs, undefined, { signal: cancellation.signal });
            await this.checkDispatch(ownerId, prepared.callId, guard);
            cancellation.signal.throwIfAborted();
            response = await this.providers.adapter(task.providerId, input.operation).invoke({
              operation: input.operation,
              inputText: input.inputText,
              systemPrompt: definition.systemPrompt,
              outputJsonSchema,
              testOutput: definition.testOutput?.(input.inputText),
              task,
              signal: AbortSignal.any([AbortSignal.timeout(task.timeoutMs), cancellation.signal]),
              ...(onText && this.providers.supportsStreaming(task.providerId)
                ? {
                    /** 校验并转发模型返回的文本增量。 */
                    onText: (delta: string) => onText(delta, prepared.callId),
                  }
                : {}),
            });
            if (
              onText &&
              !this.providers.supportsStreaming(task.providerId) &&
              response.completed
            ) {
              const result = validatedResult(
                input.operation,
                response.value,
                task.dimensions,
                definition.outputSchema,
              );
              if (result?.kind === 'text') await onText(result.text, prepared.callId);
            }
          } catch (error) {
            failure =
              error instanceof ModelProviderError
                ? error
                : new ModelProviderError(
                    error instanceof ApiException ? error.code : API_CODES.MODEL_USAGE_UNKNOWN,
                  );
          }
          attempt = await this.settle(
            ownerId,
            attempt,
            task,
            input,
            response,
            failure,
            definition,
            !onText,
          );
        }
      } finally {
        this.cancellations.delete(prepared.callId);
      }
    }
    return this.get(ownerId, prepared.callId);
  }

  /**
   * 校验模型请求的当前派发资格。
   *
   * 等待后重新检查版本、取消和范围，避免按旧配置继续发送重试。
   */
  private checkDispatch(ownerId: string, id: string, guard?: ModelDispatchGuard): Promise<void> {
    return this.configuration.locked(ownerId, async (tx, current) => {
      await guard?.(ownerId, tx);
      await expireAttempts(this.database, ownerId, tx);
      const call = await readCall(this.database, ownerId, tx, id);
      if (call.status !== 'running')
        throw new ApiException(call.errorCode ?? API_CODES.MODEL_USAGE_UNKNOWN);
      if (call.configVersion !== current.version)
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      await assertScope(this.database, ownerId, tx, call.context);
    });
  }

  /**
   * 查询模型调用详情及其尝试记录。
   *
   * 查询当前 owner 的调用；过期尝试显式转为未知，保留预算占用。
   */
  get(ownerId: string, id: string): Promise<ModelCall> {
    return this.configuration.locked(ownerId, async (tx) => {
      await expireAttempts(this.database, ownerId, tx);
      return readCall(this.database, ownerId, tx, id);
    });
  }

  /**
   * 取消模型调用并中止本进程中的网络等待。
   *
   * 先持久化取消，再中止本进程网络等待；已发出的请求仍需结算其消耗。
   */
  async cancel(ownerId: string, id: string): Promise<ModelCall> {
    const call = await this.configuration.locked(ownerId, async (tx) => {
      await expireAttempts(this.database, ownerId, tx);
      const current = await readCall(this.database, ownerId, tx, id);
      if (current.status === 'running') {
        await this.database.modelCalls.update(
          ownerId,
          id,
          {
            status: 'cancelled',
            errorCode: API_CODES.MODEL_CANCELLED,
            result: null,
            finishedAt: new Date(),
          },
          tx,
        );
      }
      return readCall(this.database, ownerId, tx, id);
    });
    if (call.status === 'cancelled') this.cancellations.get(call.id)?.abort();
    return call;
  }

  /**
   * 查询当前 UTC 日期的模型用量。
   *
   * 查询固定 UTC 当日的全局及任务用量，不因配置版本变化重置。
   */
  usage(ownerId: string): Promise<ModelUsage> {
    return this.configuration.locked(ownerId, async (tx, current) => {
      await expireAttempts(this.database, ownerId, tx);
      const day = new Date().toISOString().slice(0, 10);
      const effective = this.providers.effective(current.config);
      const rows = await tx
        .select()
        .from(modelUsageWindows)
        .where(and(eq(modelUsageWindows.ownerId, ownerId), eq(modelUsageWindows.day, day)));
      /** 组装模型任务的用量与额度视图。 */
      const view = (scope: string, limit: DailyModelBudget) => {
        const row = rows.find((row) => row.scope === scope);
        return {
          limit,
          charged: {
            requests: row?.requests ?? 0,
            tokens: row?.tokens ?? 0,
            costMicros: row?.costMicros ?? 0,
          },
        };
      };
      const active = await tx
        .select({ id: modelAttempts.id })
        .from(modelAttempts)
        .where(and(eq(modelAttempts.ownerId, ownerId), eq(modelAttempts.status, 'running')));
      return {
        day,
        configVersion: current.version,
        currency: 'USD',
        global: view('global', effective.dailyBudget),
        tasks: Object.fromEntries(
          MODEL_TASK_ROLES.map((role) => [
            role,
            view(role, current.config.tasks[role].dailyBudget),
          ]),
        ) as ModelUsage['tasks'],
        activeRequests: active.length,
      };
    });
  }

  /**
   * 结算模型调用结果和资源消耗。
   *
   * 将可观察输出与额度在同一事务结算；重试也必须再次原子预留。
   */
  private settle(
    ownerId: string,
    attempt: AttemptRow,
    task: ModelTaskConfig,
    input: ModelProbe,
    response: ModelAdapterResponse | null,
    failure: ModelProviderError | null,
    definition: ModelTaskDefinition,
    allowRetry = true,
  ): Promise<AttemptRow | null> {
    return this.configuration.locked(ownerId, async (tx, current) => {
      const saved = await this.database.modelAttempts.findById(ownerId, attempt.id, tx);
      const call = await this.database.modelCalls.findById(ownerId, attempt.callId, tx);
      if (!saved || !call) throw new ApiException(API_CODES.DATA_UNAVAILABLE);
      if (
        saved.usageSource === 'reported' ||
        ['succeeded', 'failed', 'cancelled'].includes(saved.status)
      )
        return null;
      const usage = validUsage(response?.usage);
      const tokens = usage ? usage.inputTokens + usage.outputTokens : saved.chargedTokens;
      const cost = usage
        ? costMicros(usage.inputTokens, usage.outputTokens, task)
        : saved.chargedCostMicros;
      await adjustUsage(
        this.database,
        ownerId,
        tx,
        saved.day,
        saved.role,
        tokens - saved.chargedTokens,
        cost - saved.chargedCostMicros,
      );
      let scopeError: number | null = call.invalidatedAt ? API_CODES.LIFECYCLE_RESTRICTED : null;
      try {
        await assertScope(this.database, ownerId, tx, call.context);
      } catch (error) {
        if (!(error instanceof ApiException)) throw error;
        scopeError = error.code;
      }
      const closed =
        call.status !== 'running' ||
        saved.deadlineAt.getTime() <= Date.now() ||
        scopeError !== null;
      const result =
        !closed && response?.completed
          ? validatedResult(
              input.operation,
              response.value,
              task.dimensions,
              definition.outputSchema,
            )
          : null;
      let status: CallRow['status'] =
        call.status === 'cancelled'
          ? 'cancelled'
          : closed
            ? 'unknown'
            : result
              ? 'succeeded'
              : failure?.code === API_CODES.MODEL_USAGE_UNKNOWN
                ? 'unknown'
                : 'failed';
      let errorCode: number | null = result
        ? null
        : status === 'cancelled'
          ? API_CODES.MODEL_CANCELLED
          : status === 'unknown'
            ? API_CODES.MODEL_USAGE_UNKNOWN
            : (failure?.code ?? API_CODES.MODEL_OUTPUT_INVALID);
      if (scopeError !== null) {
        status = 'failed';
        errorCode = scopeError;
      }
      const finishedAt = new Date();
      await this.database.modelAttempts.update(
        ownerId,
        saved.id,
        {
          status,
          errorCode,
          usageSource: usage ? 'reported' : 'reserved',
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          chargedTokens: tokens,
          chargedCostMicros: cost,
          actualModel: response?.actualModel?.slice(0, 160) ?? null,
          responseFingerprint: response?.responseId ? fingerprint(response.responseId) : null,
          finishedAt,
        },
        tx,
      );
      let next: AttemptRow | null = null;
      if (
        allowRetry &&
        !closed &&
        !result &&
        failure?.retryable &&
        saved.number < task.maxAttempts
      ) {
        try {
          // 新配置或停用不能让旧任务继续按旧策略派发。
          if (current.version !== call.configVersion)
            throw new ApiException(API_CODES.VERSION_CONFLICT);
          assertRunnable(input, current.config.tasks[call.role], definition);
          next = await reserveAttempt(
            this.database,
            ownerId,
            tx,
            { ...current, config: this.providers.effective(current.config) },
            call,
            task,
            input.inputText,
            saved.number + 1,
            definition,
          );
          status = 'running';
          errorCode = null;
        } catch (error) {
          if (!(error instanceof ApiException)) throw error;
          status = 'failed';
          errorCode = error.code;
        }
      }
      await this.database.modelCalls.update(
        ownerId,
        saved.callId,
        { status, errorCode, result, finishedAt: next ? null : finishedAt },
        tx,
      );
      return next;
    });
  }
}

/**
 * 估算模型输入所需的预留额度。
 *
 * 使用不依赖供应商 tokenizer 的保守输入上界；协议和提示词额外预留 512。
 */
export function modelInputReservation(
  text: string,
  definition: ModelTaskDefinition,
  operation: ModelProbe['operation'],
): number {
  if (operation === 'embedding') return Buffer.byteLength(text, 'utf8') + 128;
  const specification = outputSpecification(definition, operation);
  const overhead =
    Buffer.byteLength(definition.systemPrompt, 'utf8') +
    Buffer.byteLength(JSON.stringify(specification), 'utf8') +
    128;
  return Buffer.byteLength(text, 'utf8') + Math.max(512, overhead);
}

/**
 * 校验模型任务配置、输入和供应商能力。
 *
 * 先验证能力、已配置价格和输入上限，再写预留或访问供应商。
 */
function assertRunnable(
  input: ModelProbe,
  task: ModelTaskConfig,
  definition: ModelTaskDefinition,
): void {
  if (
    !task.enabled ||
    (task.providerId !== 'test' &&
      (task.inputMicrosPerMillion === null || task.outputMicrosPerMillion === null))
  )
    throw new ApiException(API_CODES.MODEL_NOT_CONFIGURED);
  if ((input.role === 'embedding') !== (input.operation === 'embedding'))
    throw new ApiException(API_CODES.INVALID_REQUEST);
  if (modelInputReservation(input.inputText, definition, input.operation) > task.maxInputTokens)
    throw new ApiException(API_CODES.INVALID_REQUEST, '输入超过此任务的单次预算。');
}

/**
 * 为一次模型请求尝试预留预算和并发容量。
 *
 * 在已持有部署配置锁的事务中预留一次请求；全局和任务必须同时有额度。
 * @returns 已持久保存、可以在事务外发送的尝试。
 */
async function reserveAttempt(
  database: DatabaseService,
  ownerId: string,
  tx: DatabaseTransaction,
  current: ModelConfigurationVersion,
  call: CallRow,
  task: ModelTaskConfig,
  inputText: string,
  number: number,
  definition: ModelTaskDefinition,
): Promise<AttemptRow> {
  const active = await tx
    .select({ lane: modelAttempts.lane })
    .from(modelAttempts)
    .where(and(eq(modelAttempts.ownerId, ownerId), eq(modelAttempts.status, 'running')));
  if (
    active.length >= current.config.maxConcurrent ||
    (call.lane === 'background' &&
      active.filter((a) => a.lane === 'background').length >= current.config.backgroundConcurrent)
  )
    throw new ApiException(API_CODES.MODEL_CAPACITY_EXCEEDED);
  const inputTokens = modelInputReservation(inputText, definition, call.operation);
  const tokens = inputTokens + task.maxOutputTokens;
  const cost = costMicros(inputTokens, task.maxOutputTokens, task);
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const windows: (typeof modelUsageWindows.$inferSelect)[] = [];
  for (const scope of ['global', call.role]) {
    const limit =
      scope === 'global' ? current.config.dailyBudget : current.config.tasks[call.role].dailyBudget;
    await tx
      .insert(modelUsageWindows)
      .values({ ownerId, day, scope })
      .onDuplicateKeyUpdate({ set: { scope } });
    const window = await database.modelUsageWindows.findOne(ownerId, { where: { day, scope } }, tx);
    if (!window) throw new ApiException(API_CODES.DATA_UNAVAILABLE);
    if (
      window.requests + 1 > limit.requests ||
      window.tokens + tokens > limit.tokens ||
      window.costMicros + cost > limit.costMicros
    )
      throw new ApiException(API_CODES.MODEL_BUDGET_EXCEEDED);
    windows.push(window);
  }
  for (const window of windows) {
    await database.modelUsageWindows.update(
      ownerId,
      window.id,
      {
        requests: window.requests + 1,
        tokens: window.tokens + tokens,
        costMicros: window.costMicros + cost,
      },
      tx,
    );
  }
  const attempt: AttemptRow = {
    id: randomUUID(),
    ownerId,
    callId: call.id,
    number,
    role: call.role,
    lane: call.lane,
    day,
    status: 'running',
    usageSource: 'reserved',
    inputTokens: null,
    outputTokens: null,
    chargedTokens: tokens,
    chargedCostMicros: cost,
    errorCode: null,
    actualModel: null,
    responseFingerprint: null,
    startedAt: now,
    deadlineAt: new Date(
      now.getTime() + task.timeoutMs + (number > 1 ? task.retryDelayMs : 0) + 1000,
    ),
    finishedAt: null,
  };
  await tx.insert(modelAttempts).values(attempt);
  return attempt;
}

/**
 * 计算模型调用的微美元费用。
 *
 * 用整数微单位向上取整，避免浮点金额累计误差。
 */
function costMicros(inputTokens: number, outputTokens: number, task: ModelTaskConfig): number {
  const numerator =
    BigInt(inputTokens) * BigInt(task.inputMicrosPerMillion ?? 0) +
    BigInt(outputTokens) * BigInt(task.outputMicrosPerMillion ?? 0);
  return Number((numerator + 999_999n) / 1_000_000n);
}

/**
 * 调整模型用量窗口中的预留和实际消耗。
 *
 * 原窗口结算，即使调用跨日结束，也不将前一天的预留扣到新一天。
 */
async function adjustUsage(
  database: DatabaseService,
  ownerId: string,
  tx: DatabaseTransaction,
  day: string,
  role: string,
  tokenDelta: number,
  costDelta: number,
): Promise<void> {
  for (const scope of ['global', role]) {
    const window = await database.modelUsageWindows.findOne(ownerId, { where: { day, scope } }, tx);
    if (!window) throw new ApiException(API_CODES.DATA_UNAVAILABLE);
    await database.modelUsageWindows.update(
      ownerId,
      window.id,
      { tokens: window.tokens + tokenDelta, costMicros: window.costMicros + costDelta },
      tx,
    );
  }
}

/**
 * 校验供应商返回的用量数据。
 *
 * 外部用量也要校验，缺失或畸形时不能当成零消耗。
 */
function validUsage(value: unknown): ModelAdapterResponse['usage'] {
  const parsed = z
    .object({
      inputTokens: z.number().int().min(0).max(10_000_000),
      outputTokens: z.number().int().min(0).max(10_000_000),
    })
    .safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * 校验并转换模型输出结果。
 *
 * 严格校验完整文本、诊断字段和向量维度，不自动修复或调用第二个模型。
 */
function validatedResult(
  operation: ModelProbe['operation'],
  value: unknown,
  dimensions: number | null,
  outputSchema?: z.ZodType,
): ModelResult | null {
  try {
    if (operation === 'text') return modelResultSchema.parse({ kind: 'text', text: value });
    if (operation === 'embedding') {
      const result = modelResultSchema.parse({ kind: 'embedding', vector: value });
      return result.kind === 'embedding' && result.vector.length === dimensions ? result : null;
    }
    const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
    return { kind: 'structured', value: z.json().parse(outputSchema?.parse(parsed)) };
  } catch {
    return null;
  }
}

/**
 * 将超时的模型请求尝试标记为结果未知。
 *
 * 进程消失或结果迟到时，保留预留并明确标记未知，不自动重复调用。
 */
async function expireAttempts(
  database: DatabaseService,
  ownerId: string,
  tx: DatabaseTransaction,
): Promise<void> {
  const expired = await tx
    .select()
    .from(modelAttempts)
    .where(
      and(
        eq(modelAttempts.ownerId, ownerId),
        eq(modelAttempts.status, 'running'),
        lte(modelAttempts.deadlineAt, new Date()),
      ),
    );
  for (const row of expired) {
    const state = {
      status: 'unknown' as const,
      errorCode: API_CODES.MODEL_USAGE_UNKNOWN,
      finishedAt: new Date(),
    };
    await database.modelAttempts.update(ownerId, row.id, state, tx);
    await database.modelCalls.updateWhere(
      ownerId,
      { where: { id: row.callId, status: 'running' }, set: state },
      tx,
    );
  }
}

/**
 * 读取并组装模型调用及其尝试详情。
 *
 * 只映射本部署的可展示字段，排序保持真实尝试次序。
 */
async function readCall(
  database: DatabaseService,
  ownerId: string,
  tx: DatabaseTransaction,
  id: string,
): Promise<ModelCall> {
  const call = await database.modelCalls.findById(ownerId, id, tx);
  if (!call) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
  let invalidated = Boolean(call.invalidatedAt);
  try {
    await assertScope(database, ownerId, tx, call.context);
  } catch (error) {
    if (!(error instanceof ApiException)) throw error;
    invalidated = true;
  }
  const rows = await tx
    .select()
    .from(modelAttempts)
    .where(and(eq(modelAttempts.ownerId, ownerId), eq(modelAttempts.callId, id)))
    .orderBy(asc(modelAttempts.number));
  const attempts: ModelAttempt[] = rows.map((row) => ({
    id: row.id,
    number: row.number,
    status: row.status,
    usageSource: row.usageSource,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    chargedTokens: row.chargedTokens,
    chargedCostMicros: row.chargedCostMicros,
    errorCode: row.errorCode,
    actualModel: row.actualModel,
    responseFingerprint: row.responseFingerprint,
    startedAt: row.startedAt.toISOString(),
    deadlineAt: row.deadlineAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }));
  return {
    id: call.id,
    requestId: call.requestId,
    context: call.context,
    role: call.role,
    operation: call.operation,
    lane: call.lane,
    configVersion: call.configVersion,
    providerId: call.providerId,
    model: call.model,
    status: call.status,
    errorCode: call.errorCode,
    result: invalidated ? null : call.result,
    attempts,
    createdAt: call.createdAt.toISOString(),
    finishedAt: call.finishedAt?.toISOString() ?? null,
  };
}

/**
 * 根据任务定义生成模型输出规范。
 *
 * 从业务拥有的 Zod 规则生成输出规范，不接收客户端自由 schema。
 */
function outputSpecification(
  definition: ModelTaskDefinition,
  operation: ModelProbe['operation'],
): Record<string, unknown> | null {
  if (operation !== 'structured') return null;
  if (!definition.outputSchema)
    throw new ApiException(API_CODES.MODEL_NOT_CONFIGURED, '结构化任务缺少输出规范。');
  try {
    const schema = z.toJSONSchema(definition.outputSchema);
    delete schema.$schema;
    return schema;
  } catch {
    throw new ApiException(API_CODES.MODEL_NOT_CONFIGURED, '输出规范不能转换为 JSON schema。');
  }
}

/**
 * 校验模型调用的用户、实例和会话范围。
 *
 * 相同 owner、有效运行代次及当前会话成员是模型调用的必要范围。
 */
async function assertScope(
  database: DatabaseService,
  ownerId: string,
  tx: DatabaseTransaction,
  context: ModelCallContext,
): Promise<void> {
  if ((context.companionId === null) !== (context.runtimeEpoch === null))
    throw new ApiException(API_CODES.INVALID_REQUEST);
  if (context.conversationId) await requireConversation(ownerId, context.conversationId, tx);
  if (context.companionId && context.runtimeEpoch !== null) {
    await requireCompanion(database, ownerId, context.companionId, context.runtimeEpoch, tx);
    if (context.conversationId) {
      const member = await requireCompanionMember(
        database,
        ownerId,
        context.companionId,
        context.runtimeEpoch,
        context.conversationId,
        tx,
      );
      if (member.leftSequence !== null) throw new ApiException(API_CODES.MEMBER_LEFT);
    }
  }
}
