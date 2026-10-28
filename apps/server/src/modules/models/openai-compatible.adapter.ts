import { API_CODES } from '@memory-weave/contracts';
import { z } from 'zod';
import type { ModelAdapter, ModelAdapterRequest, ModelAdapterResponse } from './model-adapter';
import type { ModelProvider } from './model-deployment';

/** 外部失败只携带受控分类，不能把 URL、凭据或响应正文传到日志。 */
export class ModelProviderError extends Error {
  constructor(
    readonly code: number,
    readonly retryable = false,
  ) {
    super('模型供应商请求未完成。');
  }
}

/** 兼容 Chat Completions / Embeddings 的单次 HTTP adapter；不隐式重试。 */
export class OpenAiCompatibleAdapter implements ModelAdapter {
  constructor(private readonly provider: ModelProvider) {}

  /** 严格限制响应体、超时和重定向，JSON 数据仍需统一入口校验。 */
  async invoke(request: ModelAdapterRequest): Promise<ModelAdapterResponse> {
    const embedding = request.operation === 'embedding';
    const body: Record<string, unknown> = embedding
      ? {
          model: request.task.model,
          input: request.inputText,
          encoding_format: 'float',
          ...(this.provider.sendEmbeddingDimensions ? { dimensions: request.task.dimensions } : {}),
        }
      : {
          model: request.task.model,
          stream: false,
          messages: [
            {
              role: 'system',
              content: request.systemPrompt,
            },
            { role: 'user', content: request.inputText },
          ],
          [this.provider.outputTokenParameter]: request.task.maxOutputTokens,
          ...(request.task.temperature === null ? {} : { temperature: request.task.temperature }),
        };
    if (request.operation === 'structured') {
      body.response_format =
        this.provider.structuredFormat === 'json_object'
          ? { type: 'json_object' }
          : {
              type: 'json_schema',
              json_schema: {
                name: 'memory_weave_output',
                strict: true,
                schema: request.outputJsonSchema,
              },
            };
    }
    let response: Response;
    try {
      response = await fetch(
        `${this.provider.baseUrl}/${embedding ? 'embeddings' : 'chat/completions'}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.provider.apiKey ? { authorization: `Bearer ${this.provider.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: request.signal,
          redirect: 'error',
        },
      );
    } catch {
      throw new ModelProviderError(API_CODES.MODEL_USAGE_UNKNOWN);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ModelProviderError(
        API_CODES.MODEL_PROVIDER_FAILED,
        [429, 500, 502, 503, 504].includes(response.status),
      );
    }
    const data = await readJson(response);
    const common = z
      .object({
        model: z.string().max(160).optional(),
        id: z.string().max(512).optional(),
        usage: z.unknown().optional(),
      })
      .safeParse(data);
    if (!common.success) throw new ModelProviderError(API_CODES.MODEL_OUTPUT_INVALID);
    const usage = z
      .object({
        prompt_tokens: z.number().int().min(0).max(10_000_000),
        completion_tokens: z.number().int().min(0).max(10_000_000).optional(),
      })
      .safeParse(common.data.usage);
    const base = {
      actualModel: common.data.model ?? null,
      responseId: common.data.id ?? null,
      usage:
        usage.success && (embedding || usage.data.completion_tokens !== undefined)
          ? {
              inputTokens: usage.data.prompt_tokens,
              outputTokens: embedding ? 0 : usage.data.completion_tokens!,
            }
          : null,
    };
    if (embedding) {
      const parsed = z
        .object({
          data: z.array(z.object({ index: z.number().int(), embedding: z.unknown() })).length(1),
        })
        .safeParse(data);
      return {
        ...base,
        completed: parsed.success && parsed.data.data[0]!.index === 0,
        value: parsed.success ? parsed.data.data[0]!.embedding : null,
      };
    }
    const parsed = z
      .object({
        choices: z
          .array(
            z.object({
              finish_reason: z.string().nullable(),
              message: z.object({
                content: z.unknown(),
                refusal: z.unknown().optional(),
                tool_calls: z.unknown().optional(),
              }),
            }),
          )
          .length(1),
      })
      .safeParse(data);
    const choice = parsed.success ? parsed.data.choices[0] : null;
    return {
      ...base,
      completed:
        choice?.finish_reason === 'stop' && !choice.message.refusal && !choice.message.tool_calls,
      value: choice?.message.content ?? null,
    };
  }
}

/** 限制响应大小，避免供应商意外返回巨大页面或无界内容。 */
async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ModelProviderError(API_CODES.MODEL_OUTPUT_INVALID);
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 1_048_576) {
        await reader.cancel();
        throw new ModelProviderError(API_CODES.MODEL_OUTPUT_INVALID);
      }
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof ModelProviderError) throw error;
    throw new ModelProviderError(
      error instanceof SyntaxError ? API_CODES.MODEL_OUTPUT_INVALID : API_CODES.MODEL_USAGE_UNKNOWN,
    );
  } finally {
    reader.releaseLock();
  }
}
