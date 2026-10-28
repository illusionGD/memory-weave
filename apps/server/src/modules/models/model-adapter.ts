import type { ModelOperation, ModelTaskConfig } from '@memory-weave/contracts';

/** 只传递当前调用所需的配置和输入，adapter 不持有业务数据库。 */
export interface ModelAdapterRequest {
  /** 请求的操作类型。 */
  operation: ModelOperation;
  /** 本次固定的任务配置。 */
  task: ModelTaskConfig;
  /** 已限制体积的原文输入，不写日志。 */
  inputText: string;
  /** 服务端任务定义提供的实际系统提示词。 */
  systemPrompt: string;
  /** 从输出规则生成的 JSON schema，非结构化任务为 null。 */
  outputJsonSchema: Record<string, unknown> | null;
  /** 仅供确定性 adapter 使用的任务验证输出。 */
  testOutput?: unknown;
  /** 外部调用取消或超时信号。 */
  signal: AbortSignal;
}

/** 供应商输出仍视为不可信；统一入口负责结构与维度校验。 */
export interface ModelAdapterResponse {
  /** 文本、JSON 字符串或向量，必须经过调用类型对应的校验。 */
  value: unknown;
  /** 完整完成时为 true，截断、拒绝或工具调用不能当作完整文本。 */
  completed: boolean;
  /** 上报的输入/输出用量；缺失时保持保守预留。 */
  usage: { inputTokens: number; outputTokens: number } | null;
  /** 响应中实际的模型名称。 */
  actualModel: string | null;
  /** 供应商请求或响应标识，仅保存不可逆指纹。 */
  responseId: string | null;
}

/** 模型供应商边界；显式一次尝试，不在内部重试。 */
export interface ModelAdapter {
  /** 一次且仅一次向供应商发送请求，所有重试由计量入口负责。 */
  invoke(request: ModelAdapterRequest): Promise<ModelAdapterResponse>;
}

/** 不联网的固定协议测试，不评价语义效果或人格表现。 */
export class DeterministicModelAdapter implements ModelAdapter {
  async invoke(request: ModelAdapterRequest): Promise<ModelAdapterResponse> {
    request.signal.throwIfAborted();
    const text = `测试模型已收到：${request.inputText}`;
    return {
      value:
        request.testOutput !== undefined
          ? request.operation === 'structured'
            ? JSON.stringify(request.testOutput)
            : request.testOutput
          : request.operation === 'embedding'
            ? Array.from({ length: request.task.dimensions ?? 4 }, (_, i) => (i === 0 ? 1 : 0))
            : request.operation === 'structured'
              ? JSON.stringify({ ok: true, reply: text })
              : text,
      completed: true,
      usage: { inputTokens: 12, outputTokens: request.operation === 'embedding' ? 0 : 8 },
      actualModel: request.task.model,
      responseId: null,
    };
  }
}
