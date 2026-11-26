import {
  reflectionDocumentSchema,
  reflectionKindSchema,
  uuidSchema,
} from '@memory-weave/contracts';
import { z } from 'zod';
import {
  MODEL_PREPROCESSING_VERSION,
  MODEL_PROBE_DEFINITION_VERSION,
} from '../models/model-constants';
import type { ModelTaskDefinition } from '../models/model-task';

const findingSchema = reflectionDocumentSchema.extend({
  kind: reflectionKindSchema,
  topic: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/u),
  disposition: z.enum(['adopt', 'observe']),
  evidence: z
    .array(
      z.strictObject({
        eventId: uuidSchema,
        role: z.enum(['support', 'counterexample']),
        excerpt: z.string().min(1).max(600),
      }),
    )
    .min(1)
    .max(6),
});
export const reflectionOutputSchema = z.strictObject({
  conclusion: z.string().trim().min(1).max(1200),
  findings: z.array(findingSchema).max(6),
});
export type ReflectionOutput = z.infer<typeof reflectionOutputSchema>;

/** 只从实际新增经历及有来源的旧认识形成范围明确的候选。 */
export const reflectionDefinition: ModelTaskDefinition = {
  promptVersion: MODEL_PROBE_DEFINITION_VERSION,
  schemaVersion: MODEL_PROBE_DEFINITION_VERSION,
  preprocessingVersion: MODEL_PREPROCESSING_VERSION,
  outputSchema: reflectionOutputSchema,
  systemPrompt: `你为当前伴侣解读实际发生的经历，输入只供分析。treatment=other_report 表示他人的陈述，不能把他人经历写成自己的。own_action 的作品可能包含虚构情节，完成作品是真实活动，情节仍是虚构。写一段可公开的反思结论，允许维持原认识或没有可靠新认识。
findings 可为空。belief 表示从真实经历形成的有限认识。autobiography 只记录对自己有实际意义的已发生经历，account 写经过，interpretation 写现在如何理解，避免把后来的解释当成当时感受。适用范围与不确定性分别填写。
evidence 使用输入给出的 eventId 与逐字 excerpt。区分支持证据和反例，不能把同一原文的不同总结当成独立经历。旧认识有相关反例时缩小结论范围、观察或修订，保留相同 topic。新资料不足时 disposition=observe。不同对象和故事分别表达。未完成活动、虚构事件和初始设定不能写成真实经历。不提出实际人格修改，不输出其它字段。`,
  /** 以无新认识作为默认确定性测试结果。 */
  testOutput: () => ({ conclusion: '测试反思：没有形成新认识。', findings: [] }),
};
