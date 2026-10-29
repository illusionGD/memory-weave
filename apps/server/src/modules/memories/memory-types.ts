import type { MemoryConfiguration, MemoryItem } from '@memory-weave/contracts';
/** 固定的原文输入，重启恢复不能重新选择范围或替换正文。 */
export interface MemoryInputMessage {
  /** 精确原文身份。 */
  messageId: string;
  /** 发布正文版本。 */
  contentVersion: number;
  /** 会话中实际发布序号。 */
  sequence: number;
  /** 本次取得的完整原文。 */
  text: string;
  /** 发布者身份，不能由模型改写。 */
  speaker: { kind: 'user' | 'companion'; id: string };
  /** 发布时间，不冒充经历时间。 */
  publishedAt: string;
  /** 本批需要推进范围的新原文；false 仅用于前置上下文。 */
  target: boolean;
  /** 原文标注的现实或虚构范围。 */
  reality: 'real' | 'fictional' | 'unspecified';
  /** 原文的陈述、转述或推断性质。 */
  epistemic: 'statement' | 'report' | 'inference' | 'setting';
  /** 用户输入、管理员代写与模型输出保持区分。 */
  sourceKind: 'user_input' | 'admin_companion_input' | 'model_output';
  /** 原文明确指定的经历时间。 */
  occurredAt: string | null;
  /** 原文明确的适用起点。 */
  validFrom: string | null;
  /** 原文明确的适用终点。 */
  validUntil: string | null;
}
/** 批次快照由服务端构造，不接受模型扩充来源。 */
export interface MemoryBatchInput {
  /** 该次体验所属伴侣。 */
  companionId: string;
  /** 固定的成员授权版本。 */
  permissionVersion: number;
  /** 有界的原文输入，不接受模型补充身份。 */
  messages: MemoryInputMessage[];
  /** 同会话旧记忆的确切版本。 */
  related: MemoryItem[];
}
/** 配置与结果均随批次保存；时间戳以数据库提交为准。 */
export type MemoryBatchConfiguration = MemoryConfiguration;
