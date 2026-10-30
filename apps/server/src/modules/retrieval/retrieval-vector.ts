import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { API_CODES } from '@memory-weave/contracts';
import { ApiException } from '../../http/api-exception';
import type { ModelTaskConfig } from '@memory-weave/contracts';
import type { RuntimeConfig } from '../../config';
import { SERVER_CONFIG } from '../../config';
import { fingerprint } from '../shared/http';
import type { ModelTaskDefinition } from '../models/model-task';

/** 仅把编码相关配置纳入空间，价格及预算调整不要求重建。 */
export function embeddingSpace(task: ModelTaskConfig, config: RuntimeConfig): string {
  return fingerprint({
    provider: task.providerId,
    endpoint:
      config.modelDeployment?.providers.find((p) => p.id === task.providerId)?.baseUrl ?? null,
    model: task.model,
    dimensions: task.dimensions,
    prompt: task.promptVersion,
    schema: task.schemaVersion,
    preprocessing: task.preprocessingVersion,
    encoding: 'memory-context-v1',
  });
}
/** collection 按部署与编码隔离；正文从不写入 payload。 */
export function vectorCollection(ownerId: string, space: string): string {
  return `mw_${ownerId.replaceAll('-', '')}_${space.slice(0, 48)}`;
}
/** embedding 无生成提示词，定义版本仍由统一模型入口校验。 */
export function embeddingDefinition(task: ModelTaskConfig): ModelTaskDefinition {
  return {
    promptVersion: task.promptVersion,
    schemaVersion: task.schemaVersion,
    preprocessingVersion: task.preprocessingVersion,
    systemPrompt: '',
  };
}

/** Qdrant 系统边界：短超时、有界响应、无重定向及幂等点身份。 */
@Injectable()
export class RetrievalVector {
  private readonly ready = new Set<string>();
  constructor(@Inject(SERVER_CONFIG) private readonly config: RuntimeConfig) {}
  /** 建立指定维度的独立空间及过滤字段索引；失败不会改变主库记忆。 */
  async ensure(collection: string, dimensions: number): Promise<void> {
    if (this.ready.has(collection)) return;
    const existing = await this.request(`/collections/${collection}`, 'GET', undefined, true);
    if (existing === null)
      await this.request(`/collections/${collection}`, 'PUT', {
        vectors: { size: dimensions, distance: 'Cosine' },
        on_disk_payload: true,
      });
    else {
      const parsed = z
        .object({
          result: z.object({
            config: z.object({ params: z.object({ vectors: z.object({ size: z.number() }) }) }),
          }),
        })
        .parse(existing);
      if (parsed.result.config.params.vectors.size !== dimensions)
        throw new Error('向量空间维度不一致。');
    }
    for (const field of ['owner', 'companion', 'epoch', 'conversation', 'space'])
      await this.request(`/collections/${collection}/index?wait=true`, 'PUT', {
        field_name: field,
        field_schema: field === 'epoch' ? 'integer' : 'keyword',
      });
    this.ready.add(collection);
  }
  /** wait=true 确认 Qdrant 已应用；重复提交同一点只替换同一派生版本。 */
  async upsert(
    collection: string,
    id: string,
    vector: number[],
    payload: Record<string, string | number>,
  ): Promise<void> {
    await this.ensure(collection, vector.length);
    const body = { points: [{ id, vector, payload }] };
    const result = await this.request(
      `/collections/${collection}/points?wait=true&ordering=strong`,
      'PUT',
      body,
      true,
    );
    if (result === null) {
      this.ready.delete(collection);
      await this.ensure(collection, vector.length);
      await this.request(
        `/collections/${collection}/points?wait=true&ordering=strong`,
        'PUT',
        body,
      );
    }
  }
  /** ANN 带范围过滤；命中后仍须到主库复核。 */
  async query(
    collection: string,
    vector: number[],
    scope: {
      owner: string;
      companion: string;
      epoch: number;
      space: string;
      conversations: string[];
    },
    limit: number,
    exact = false,
  ): Promise<string[]> {
    if (!scope.conversations.length) return [];
    const result = await this.request(
      `/collections/${collection}/points/query`,
      'POST',
      {
        query: vector,
        limit,
        score_threshold: this.config.retrievalConfiguration?.vectorMinScore ?? 0.3,
        with_payload: false,
        with_vector: false,
        params: { exact, hnsw_ef: Math.max(64, limit * 2) },
        filter: {
          must: [
            ...['owner', 'companion', 'epoch', 'space'].map((key) => ({
              key,
              match: { value: scope[key as 'owner' | 'companion' | 'epoch' | 'space'] },
            })),
            { key: 'conversation', match: { any: scope.conversations } },
          ],
        },
      },
      true,
    );
    if (result === null) throw new ApiException(API_CODES.DATA_UNAVAILABLE, '向量空间尚待重建。');
    return z
      .object({ result: z.object({ points: z.array(z.object({ id: z.uuid() })).max(200) }) })
      .parse(result)
      .result.points.map((point) => point.id);
  }
  /** 明确删除点；不存在的 collection 等价于没有相应派生数据。 */
  async remove(collection: string, ids: string[]): Promise<void> {
    if (ids.length)
      await this.request(
        `/collections/${collection}/points/delete?wait=true&ordering=strong`,
        'POST',
        { points: ids },
        true,
      );
  }
  private async request(
    path: string,
    method: string,
    body?: unknown,
    missing = false,
  ): Promise<unknown | null> {
    try {
      const response = await fetch(`${this.config.qdrantUrl}${path}`, {
        method,
        headers: { 'api-key': this.config.qdrantApiKey, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.retrievalConfiguration?.vectorTimeoutMs ?? 1500),
      });
      if (missing && response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('向量服务暂不可用。');
      }
      if (!response.body) throw new Error('向量响应为空。');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 2 * 1024 * 1024) {
            await reader.cancel();
            throw new Error('向量响应超限。');
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new ApiException(API_CODES.DATA_UNAVAILABLE, '向量服务暂不可用。');
    }
  }
}
