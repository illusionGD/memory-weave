import { z } from 'zod';
import { uuidSchema } from '@memory-weave/contracts';
import {
  MODEL_PREPROCESSING_VERSION,
  MODEL_PROBE_DEFINITION_VERSION,
} from '../models/model-constants';
import type { ModelTaskDefinition } from '../models/model-task';

export const autonomyChoiceSchema = z
  .strictObject({
    choice: z.enum(['quiet', 'write', 'contact', 'peer_invite']),
    reason: z.string().trim().min(1).max(400),
    text: z.string().trim().min(1).max(600).nullable(),
    peerId: uuidSchema.nullable().optional(),
  })
  .refine(({ choice, text, peerId }) =>
    choice === 'peer_invite'
      ? Boolean(peerId && text === null)
      : !peerId && (choice === 'quiet') === (text === null),
  );

/** 只提出一次自主机会，程序负责实际执行、保存与发送。 */
export const autonomyDefinition: ModelTaskDefinition = {
  promptVersion: MODEL_PROBE_DEFINITION_VERSION,
  schemaVersion: MODEL_PROBE_DEFINITION_VERSION,
  preprocessingVersion: MODEL_PREPROCESSING_VERSION,
  outputSchema: autonomyChoiceSchema,
  systemPrompt: `你可按当前人格和实际可见资料选择保持安静、安排一个独立短篇写作目标，或提出一条给用户的简短联系意向。没有足够理由时选择 quiet。write 的 text 写要实际完成的目标，contact 的 text 写可能发送的话。当前环境没有外部工具。不得声称尚未完成的事情已经完成，也不把初始剧情当成现实经历。用户未确认的情绪和意图保持不确定。实际通知由程序再检查。只有明确允许 contact 时才提出联系。若公开同伴简介适合交流，可选择 peer_invite，填写其 peerId 并将 text 设为空。邀请不共享私聊消息。`,
  /** 测试模式默认保持安静。 */
  testOutput: () => ({ choice: 'quiet', reason: '测试机会无需执行。', text: null }),
};
