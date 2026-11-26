import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const base = new URL(process.env.F24_QDRANT_URL ?? 'http://127.0.0.1:6333');
const key = process.env.F24_QDRANT_KEY;
const points = Number(process.env.F24_VECTOR_POINTS ?? 10000);
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
  !key ||
  !Number.isInteger(points) ||
  points < 100 ||
  points > 100000
)
  throw new Error('请提供本地隔离向量服务、测试密钥和 100 至 100000 个测试点。');
const collection = `/collections/mw_f24_${randomUUID().replaceAll('-', '')}`;

/** 访问隔离的真实 Qdrant。 */
async function request(path, method, body) {
  const result = await fetch(new URL(`${collection}${path}`, base), {
    method,
    headers: { 'api-key': key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!result.ok) throw new Error(`Qdrant HTTP ${result.status} (${method} ${path})`);
  return (await result.json()).result;
}

/** 固定数值向量避免外部模型调用，同时复现维度和范围限制。 */
function vector(index) {
  return Array.from({ length: 64 }, (_, dim) => Math.sin((index + 1) * (dim + 11)));
}

await request('', 'PUT', { vectors: { size: 64, distance: 'Cosine' }, on_disk_payload: true });
try {
  await request('/index?wait=true', 'PUT', { field_name: 'scope', field_schema: 'integer' });
  const ingest = performance.now();
  for (let start = 0; start < points; start += 256) {
    const ids = Array.from({ length: Math.min(256, points - start) }, (_, step) => start + step);
    await request('/points?wait=true&ordering=strong', 'PUT', {
      points: ids.map((id) => ({ id, vector: vector(id), payload: { scope: id % 10 } })),
    });
  }
  const ingestMs = performance.now() - ingest;
  const count = (await request('/points/count', 'POST', { exact: true })).count;
  if (count !== points) throw new Error('写入数量与确切点数不一致。');
  const elapsed = [];
  for (let index = 0; index < 100; index++) {
    const start = performance.now();
    const result = await request('/points/query', 'POST', {
      query: vector(index),
      limit: 10,
      params: { exact: true },
      filter: { must: [{ key: 'scope', match: { value: index % 10 } }] },
    });
    elapsed.push(performance.now() - start);
    if (result.points[0]?.id !== index) throw new Error('精确范围查询未取得预期点。');
  }
  elapsed.sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        points: count,
        dimensions: 64,
        queries: elapsed.length,
        ingestSeconds: Number((ingestMs / 1000).toFixed(2)),
        exactFilterMs: { p50: Number(elapsed[49].toFixed(2)), p95: Number(elapsed[94].toFixed(2)) },
      },
      null,
      2,
    ),
  );
} finally {
  await request('', 'DELETE');
}
