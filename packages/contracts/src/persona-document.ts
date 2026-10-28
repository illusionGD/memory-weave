import { z } from 'zod';

const evidenceShape = {
  /** 自然语言整理内容，不使用人格分数。 */
  text: z.string().trim().min(1).max(600),
  /** 原稿中的连续引文，服务端必须检查确实存在。 */
  evidence: z.string().min(1).max(800),
};
/** 有原稿依据的初始设定条目，不代表亲历。 */
export const personaEvidenceSchema: z.ZodObject<typeof evidenceShape, z.core.$strict> = z
  .object(evidenceShape)
  .strict();
const lockShape = {
  /** 长期保留的约束；自动提取时直接保留原稿原句。 */
  text: z.string().min(1).max(800),
  /** explicit 表示管理者直接指定，profile 表示从原稿提取。 */
  source: z.enum(['explicit', 'profile']),
};
/** 约束由明确意图产生，不能将全部普通性格描述锁定。 */
export const personaLockSchema: z.ZodObject<typeof lockShape, z.core.$strict> = z
  .object(lockShape)
  .strict();
const documentShape = {
  /** 人格文档结构版本。 */
  schemaVersion: z.literal(1),
  /** 初始设定的来源，不混入对话经历。 */
  sourceKind: z.literal('initial_setting'),
  /** 名称来自明确填写或原稿整理；未指定时可生成。 */
  name: z.string().trim().min(1).max(80),
  /** 核心身份、角色与背景，自动成长不得改写。 */
  core: z.array(personaEvidenceSchema).max(20),
  /** 可逐渐成长的兴趣、表达、思考方式与观点。 */
  inclinations: z.array(personaEvidenceSchema).max(30),
  /** 起初的知识与技能状态，不等同于喜恶或成长约束。 */
  knowledge: z.array(personaEvidenceSchema).max(20),
  /** 管理者明确要求长期保留的约束。 */
  locks: z.array(personaLockSchema).max(40),
};
/** 初始与当前人格均使用此自然语言结构，分别保存版本。 */
export const personaDocumentSchema: z.ZodObject<typeof documentShape, z.core.$strict> = z
  .object(documentShape)
  .strict();
/** 可持久保存的人格文档。 */
export type PersonaDocument = z.infer<typeof personaDocumentSchema>;
