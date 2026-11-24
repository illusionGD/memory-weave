import {
  materialSummaryProgressSchema,
  materialPartsPageSchema,
  materialSummarySchema,
} from '@memory-weave/contracts';
import type {
  MaterialSummaryProgress,
  MaterialSummaryRequest,
  MaterialPartsPage,
  MaterialSummary,
  MaterialUpload,
} from '@memory-weave/contracts';
import { request, requestJson } from './http';

/** 保存原件；重试复用调用方提供的上传命令身份。 */
export function uploadMaterial(file: File, input: MaterialUpload): Promise<MaterialSummary> {
  return requestJson(`/api/materials?${new URLSearchParams(input)}`, materialSummarySchema, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
}

/** 查询准确材料版本的当前处理状态。 */
export function getMaterial(id: string): Promise<MaterialSummary> {
  return requestJson(`/api/materials/${id}`, materialSummarySchema);
}

/** 逐页读取结构化材料片段。 */
export function listMaterialParts(id: string, after = 0): Promise<MaterialPartsPage> {
  return requestJson(`/api/materials/${id}/parts?after=${after}`, materialPartsPageSchema);
}

/** 创建或重放一次明确请求的全文文字总结。 */
export function summarizeMaterial(
  id: string,
  input: MaterialSummaryRequest,
): Promise<MaterialSummaryProgress> {
  return requestJson(`/api/materials/${id}/summaries`, materialSummaryProgressSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** 恢复绑定当前分享的最近总结。 */
export function latestMaterialSummary(
  id: string,
  messageId: string,
  contentVersion: number,
): Promise<MaterialSummaryProgress | null> {
  return requestJson(
    `/api/materials/${id}/summaries?messageId=${messageId}&contentVersion=${contentVersion}`,
    materialSummaryProgressSchema.nullable(),
  );
}

/** 复用已认证的持久任务控制协议。 */
export async function controlMaterialSummary(
  taskId: string,
  action: 'pause' | 'resume' | 'cancel',
): Promise<void> {
  await request(`/api/tasks/${taskId}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}
