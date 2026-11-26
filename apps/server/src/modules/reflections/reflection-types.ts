import type { ReflectionKind, ReflectionSource } from '@memory-weave/contracts';

/** 固定过权限和预算的反思材料，和执行结果分别保存。 */
export interface ReflectionInput {
  events: (ReflectionSource & {
    text: string;
    occurredAt: string;
    priority: number;
    treatment: 'own_action' | 'shared_exchange' | 'other_report';
  })[];
  earlier: { kind: ReflectionKind; topic: string; interpretation: string }[];
}

/** 采用后的实际数量与结论。 */
export interface ReflectionRunResult {
  conclusion: string;
  adopted: number;
  observing: number;
  rejected: number;
}
