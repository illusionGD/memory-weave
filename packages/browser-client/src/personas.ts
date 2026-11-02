import {
  companionListResponseSchema,
  companionPersonaStateSchema,
  personaVersionSchema,
  personaTemplateSchema,
  personaTemplateListSchema,
  modelConfigurationVersionSchema,
  taskSchema,
} from '@memory-weave/contracts';
import type {
  CompanionListResponse,
  CompanionCreation,
  CompanionPersonaState,
  PersonaVersion,
  PersonaTemplate,
  PersonaTemplateList,
  CreatePersonaTemplate,
  UpdatePersonaTemplate,
  RevisePersonaLocks,
  InitializePersona,
  ModelConfigurationVersion,
  Task,
} from '@memory-weave/contracts';
import { requestJson } from './http';

/**
 * 向人设管理接口发送 JSON 命令。
 *
 * 将已校验命令转成同源 JSON 请求。
 */
function command(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * 分页查询伴侣列表。
 * @param afterId 上一页游标。
 * @returns 当前页伴侣。
 */
export function listCompanions(afterId?: string): Promise<CompanionListResponse> {
  return requestJson(
    `/api/companions${afterId ? `?afterId=${encodeURIComponent(afterId)}` : ''}`,
    companionListResponseSchema,
  );
}
/**
 * 提交伴侣创建请求。
 * @param input 创建命令。
 * @returns 已保存的原稿与任务。
 */
export function createCompanion(input: CompanionCreation): Promise<CompanionPersonaState> {
  return requestJson('/api/companion-creations', companionPersonaStateSchema, command(input));
}
/**
 * 查询伴侣的初始人格和当前人格。
 * @param id 伴侣标识。
 * @returns 初始与当前人格。
 */
export function getPersona(id: string): Promise<CompanionPersonaState> {
  return requestJson(
    `/api/companions/${encodeURIComponent(id)}/persona`,
    companionPersonaStateSchema,
  );
}
/**
 * 查询指定的人格历史版本。
 * @param id 伴侣标识。
 * @param epoch 运行代次。
 * @param version 人格版本。
 * @returns 不可变人格记录。
 */
export function getPersonaVersion(
  id: string,
  epoch: number,
  version: number,
): Promise<PersonaVersion> {
  return requestJson(
    `/api/companions/${encodeURIComponent(id)}/persona/versions/${version}?runtimeEpoch=${epoch}`,
    personaVersionSchema,
  );
}
/**
 * 提交伴侣的长期约束修订。
 * @param id 伴侣标识。
 * @param input 约束修订。
 * @returns 新的人格版本。
 */
export function reviseLocks(id: string, input: RevisePersonaLocks): Promise<PersonaVersion> {
  return requestJson(
    `/api/companions/${encodeURIComponent(id)}/persona/locks`,
    personaVersionSchema,
    command(input),
  );
}
/**
 * 启动或重试初始人格整理。
 * @param id 伴侣标识。
 * @param input 显式开始或重试命令。
 * @returns 当前整理状态。
 */
export function initializePersona(
  id: string,
  input: InitializePersona,
): Promise<CompanionPersonaState> {
  return requestJson(
    `/api/companions/${encodeURIComponent(id)}/persona/initialize`,
    companionPersonaStateSchema,
    command(input),
  );
}
/**
 * 提交人格整理任务的控制操作。
 * @param id 任务标识。
 * @param action 管理操作。
 * @returns 任务实际状态。
 */
export function controlPersonaTask(
  id: string,
  action: 'pause' | 'resume' | 'cancel',
): Promise<Task> {
  return requestJson(`/api/tasks/${encodeURIComponent(id)}/${action}`, taskSchema, command({}));
}
/**
 * 分页查询人设模板列表。
 * @param afterId 上一页游标。
 * @returns 最新模板版本列表。
 */
export function listTemplates(afterId?: string): Promise<PersonaTemplateList> {
  return requestJson(
    `/api/persona-templates${afterId ? `?afterId=${encodeURIComponent(afterId)}` : ''}`,
    personaTemplateListSchema,
  );
}
/**
 * 查询模板的最新版本或指定历史版本。
 * @param id 模板标识。
 * @param version 可选历史版本。
 * @returns 模板内容。
 */
export function getTemplate(id: string, version?: number): Promise<PersonaTemplate> {
  return requestJson(
    `/api/persona-templates/${encodeURIComponent(id)}${version ? `/versions/${version}` : ''}`,
    personaTemplateSchema,
  );
}
/**
 * 创建人设模板。
 * @param input 初始模板。
 * @returns 模板首版。
 */
export function createTemplate(input: CreatePersonaTemplate): Promise<PersonaTemplate> {
  return requestJson('/api/persona-templates', personaTemplateSchema, command(input));
}
/**
 * 保存人设模板的新版本。
 * @param id 模板标识。
 * @param input 新版内容及乐观版本。
 * @returns 不可变新版本。
 */
export function updateTemplate(id: string, input: UpdatePersonaTemplate): Promise<PersonaTemplate> {
  return requestJson(
    `/api/persona-templates/${encodeURIComponent(id)}/versions`,
    personaTemplateSchema,
    command(input),
  );
}
/**
 * 查询初始人格整理使用的模型配置。
 * @returns 当前人格整理使用的配置，页面只展示是否为测试模式。
 */
export function getPersonaModelConfiguration(): Promise<ModelConfigurationVersion> {
  return requestJson('/api/models/config', modelConfigurationVersionSchema);
}
