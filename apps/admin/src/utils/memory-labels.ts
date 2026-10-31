/** 记忆用途；词义与公共契约一一对应。 */
export const MEMORY_KIND_LABELS = {
  semantic: '事实与认识',
  episodic: '经历',
  relational: '关系互动',
  procedural: '方法与习惯',
  narrative: '叙事与创作',
} as const;
/** 主张类型，不将短暂状态当作稳定人格。 */
export const MEMORY_CLAIM_LABELS = {
  fact: '事实',
  preference: '偏好',
  state: '状态',
  experience: '经历',
  interaction: '互动',
  commitment: '约定',
  unfinished: '未完事项',
  creative_setting: '创作设定',
} as const;
/** 当前状态与历史版本独立显示。 */
export const MEMORY_STATUS_LABELS = {
  active: '有效',
  disputed: '存在分歧',
  invalidated: '来源已失效',
} as const;
/** 变化、纠错和保留分歧不能合并成同一种修改。 */
export const MEMORY_OPERATION_LABELS = {
  add: '新增认识',
  merge: '补充合并',
  change: '情况变化',
  correction: '纠正旧记录',
  conflict: '保留分歧',
} as const;
/** 内容认识来源不等于证据可信度评分。 */
export const MEMORY_EPISTEMIC_LABELS = {
  statement: '陈述',
  report: '转述',
  inference: '推测',
  setting: '创作设定',
} as const;
/** 图谱边的含义来自实际保存的关系。 */
export const MEMORY_EDGE_LABELS = {
  version: '所属版本',
  quote: '原文引用',
  context: '整理上下文',
  merge: '补充合并',
  change: '情况变化',
  correction: '纠正旧记录',
  conflict: '保留分歧',
  dependency: '依赖旧认识',
} as const;
/** 按浏览器本地时区展示准确记录时间，经历时间原文不经过此方法。 */
export function memoryTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}
