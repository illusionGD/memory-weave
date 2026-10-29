import { API_CODES } from '@memory-weave/contracts';
import { z } from 'zod';
import type { ModelAdapterResponse } from './model-adapter';
import { ModelProviderError } from './openai-compatible.adapter';

const frameSchema = z.object({
  id: z.string().max(512).optional(),
  model: z.string().max(160).optional(),
  choices: z
    .array(
      z.object({
        index: z.literal(0),
        delta: z.object({
          content: z.string().nullable().optional(),
          refusal: z.unknown().optional(),
          tool_calls: z.unknown().optional(),
          function_call: z.unknown().optional(),
        }),
        finish_reason: z.string().nullable(),
      }),
    )
    .max(1),
  usage: z.unknown().optional(),
});

/**
 * 逐帧消费兼容协议，中文跨字节边界仍保持完整；完成标志和用量分开校验。
 * @param response 供应商的成功 HTTP 响应。
 * @param onText 具有背压的候选文本接收器，不代表文本已被业务采用。
 * @returns 有界完整输出；未取得结束标志的断流保持未知状态。
 */
export async function readModelStream(
  response: Response,
  onText: (delta: string) => Promise<void>,
): Promise<ModelAdapterResponse> {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    await response.body?.cancel();
    throw new ModelProviderError(API_CODES.MODEL_OUTPUT_INVALID);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let bytes = 0;
  let value = '';
  let finish: string | null = null;
  let prohibited = false;
  let done = false;
  let actualModel: string | null = null;
  let responseId: string | null = null;
  let usage: ModelAdapterResponse['usage'] = null;
  try {
    while (!done) {
      let item: ReadableStreamReadResult<Uint8Array>;
      try {
        item = await reader.read();
      } catch {
        throw new ModelProviderError(API_CODES.MODEL_USAGE_UNKNOWN);
      }
      if (item.done) throw new ModelProviderError(API_CODES.MODEL_USAGE_UNKNOWN);
      bytes += item.value.byteLength;
      if (bytes > 1_048_576) throw new ModelProviderError(API_CODES.MODEL_OUTPUT_INVALID);
      try {
        buffer += decoder.decode(item.value, { stream: true });
      } catch {
        throw new ModelProviderError(API_CODES.MODEL_OUTPUT_INVALID);
      }
      while (true) {
        const separator = /\r?\n\r?\n/.exec(buffer);
        if (!separator) break;
        const event = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        if (event.length > 65536) throw new ModelProviderError(API_CODES.MODEL_OUTPUT_INVALID);
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;
        if (data === '[DONE]') {
          done = true;
          break;
        }
        let json: unknown;
        try {
          json = JSON.parse(data) as unknown;
        } catch {
          throw new ModelProviderError(API_CODES.MODEL_OUTPUT_INVALID);
        }
        const parsed = frameSchema.safeParse(json);
        if (!parsed.success) throw new ModelProviderError(API_CODES.MODEL_OUTPUT_INVALID);
        const frame = parsed.data;
        actualModel = frame.model ?? actualModel;
        responseId = frame.id ?? responseId;
        const measured = z
          .object({
            prompt_tokens: z.number().int().min(0).max(10_000_000),
            completion_tokens: z.number().int().min(0).max(10_000_000),
          })
          .safeParse(frame.usage);
        if (measured.success)
          usage = {
            inputTokens: measured.data.prompt_tokens,
            outputTokens: measured.data.completion_tokens,
          };
        const choice = frame.choices[0];
        if (!choice) continue;
        prohibited ||= Boolean(
          choice.delta.refusal || choice.delta.tool_calls || choice.delta.function_call,
        );
        const delta = choice.delta.content ?? '';
        if (delta) {
          if (finish || prohibited || value.length + delta.length > 16384)
            throw new ModelProviderError(API_CODES.MODEL_OUTPUT_INVALID);
          value += delta;
          await onText(delta);
        }
        if (choice.finish_reason !== null) {
          if (finish) throw new ModelProviderError(API_CODES.MODEL_OUTPUT_INVALID);
          finish = choice.finish_reason;
        }
      }
      if (buffer.length > 65536) throw new ModelProviderError(API_CODES.MODEL_OUTPUT_INVALID);
    }
    return { value, completed: finish === 'stop' && !prohibited, usage, actualModel, responseId };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
