import type { z } from 'zod';

/** 服务端领域模块提供的任务定义，HTTP 请求不能提交任意 schema 或提示词。 */
export interface ModelTaskDefinition {
  /** 必须与任务配置一致的提示词版本。 */
  promptVersion: string;
  /** 必须与任务配置一致的输出规范版本。 */
  schemaVersion: string;
  /** 必须与任务配置一致的输入预处理版本。 */
  preprocessingVersion: string;
  /** 实际发送的系统提示词，最多 4000 字符。 */
  systemPrompt: string;
  /** 结构化任务的本地校验；JSON schema 从同一规则生成。 */
  outputSchema?: z.ZodType;
  /** 仅供确定性 adapter 使用的固定输出，不替代真实模型评估。 */
  testOutput?: (inputText: string) => unknown;
}

/** 业务模块构建的调用范围，统一入口仍核对归属、代次和成员。 */
export interface ModelTaskScope {
  /** 关联伴侣标识，没有实例时为 null。 */
  companionId: string | null;
  /** 关联伴侣代次，与 companionId 同时有值或为空。 */
  runtimeEpoch: number | null;
  /** 关联会话标识，没有会话时为 null。 */
  conversationId: string | null;
}
