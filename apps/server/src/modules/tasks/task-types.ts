/** 持久输入由所属模块解释，客户端不能任意注册处理器。 */
export type TaskInput =
  | { kind: 'lifecycle_cleanup'; operationId: string }
  | { kind: 'redacted' }
  | { kind: 'chat_reply'; runId: string }
  | {
      kind: 'persona_initialization';
      profileText: string;
      expectedPersonaVersionId: string;
      configVersion: number;
    }
  | { kind: 'model_probe'; probe: import('@memory-weave/contracts').QueuedModelProbe }
  | { kind: 'diagnostic'; steps: number }
  | {
      kind: 'memory_extraction';
      messageId: string;
      contentVersion: number;
      sequence: number;
      permissionVersion: number;
    };

/** 发布时固定的接收范围，后续仍须重新验证权限与运行代次。 */
export interface MessageOutboxInput {
  conversationId: string;
  messageId: string;
  contentVersion: number;
  sequence: number;
  recipients: { companionId: string; runtimeEpoch: number; permissionVersion: number }[];
}

/** 仅供服务端 worker 使用，令牌不通过 HTTP 导出。 */
export interface TaskLease {
  /** 领取时的持久视图，检查点更新后以数据库为准。 */
  task: import('@memory-weave/contracts').Task;
  /** 当前执行代号。 */
  fence: number;
  /** 本次随机领取令牌。 */
  token: string;
  /** 受信任模块保存的输入。 */
  input: TaskInput;
  /** 本次尝试的配置快照，心跳不混用新配置。 */
  config: import('@memory-weave/contracts').TaskConfiguration;
}

/** 一个已实际完成的步骤；不可把推测百分比当作进度。 */
export interface TaskCheckpoint {
  completedSteps: number;
  stage: string;
  modelCallId?: string;
}
