import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

// 仅针对显式测试服务创建独占 collection，finally 删除本次创建的空间。
const base = process.env.TEST_QDRANT_URL,
  key = process.env.TEST_QDRANT_API_KEY;
if (!base || !key) throw new Error('需要 TEST_QDRANT_URL 与 TEST_QDRANT_API_KEY。');
const headers = { 'api-key': key, 'Content-Type': 'application/json' };
async function api(path, body, method = 'POST') {
  const r = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`Qdrant ${r.status}`);
  return (await r.json()).result;
}
function vector(id) {
  let state = id + 123456789;
  return Array.from({ length: 128 }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2147483648 - 1;
  });
}
function percentile(values, p) {
  return Number(
    [...values]
      .sort((a, b) => a - b)
      [Math.min(values.length - 1, Math.floor(values.length * p))].toFixed(2),
  );
}
const reports = [];
for (const size of [10000, 100000]) {
  const collection = `mw_f09_benchmark_${randomUUID().replaceAll('-', '')}`;
  const path = `/collections/${collection}`;
  try {
    await api(path, { vectors: { size: 128, distance: 'Cosine' }, on_disk_payload: true }, 'PUT');
    for (const field of ['owner', 'companion', 'epoch', 'conversation', 'space'])
      await api(
        `${path}/index?wait=true`,
        { field_name: field, field_schema: field === 'epoch' ? 'integer' : 'keyword' },
        'PUT',
      );
    const started = performance.now();
    for (let start = 0; start < size; start += 1000) {
      await api(
        `${path}/points?wait=true`,
        {
          points: Array.from({ length: Math.min(1000, size - start) }, (_, i) => {
            const id = start + i;
            return {
              id,
              vector: vector(id),
              payload: {
                owner: 'benchmark',
                companion: id % 2 ? 'B' : 'A',
                epoch: 1,
                conversation: `chat-${id % 20}`,
                space: 'synthetic-128-v1',
              },
            };
          }),
        },
        'PUT',
      );
    }
    let info;
    for (let i = 0; i < 60; i++) {
      info = await api(path, undefined, 'GET');
      if (info.status === 'green' && (size === 10000 || info.indexed_vectors_count > 0)) break;
      await delay(1000);
    }
    const ann = [],
      exact = [],
      overlap = [];
    for (let i = 0; i < 30; i++) {
      const body = {
        query: vector(size + 2 * i),
        limit: 8,
        with_payload: false,
        with_vector: false,
        filter: {
          must: [
            { key: 'owner', match: { value: 'benchmark' } },
            { key: 'companion', match: { value: 'A' } },
            { key: 'epoch', match: { value: 1 } },
            { key: 'space', match: { value: 'synthetic-128-v1' } },
          ],
        },
      };
      const t = performance.now();
      const truth = await api(`${path}/points/query`, { ...body, params: { exact: true } });
      exact.push(performance.now() - t);
      const t2 = performance.now();
      const approx = await api(`${path}/points/query`, {
        ...body,
        params: { exact: false, hnsw_ef: 64 },
      });
      ann.push(performance.now() - t2);
      overlap.push(approx.points.filter((p) => truth.points.some((q) => p.id === q.id)).length / 8);
    }
    reports.push({
      points: size,
      dimensions: 128,
      filteredPoints: size / 2,
      queries: 30,
      indexedVectors: info.indexed_vectors_count,
      buildSeconds: Number(((performance.now() - started) / 1000).toFixed(1)),
      exactMs: { p50: percentile(exact, 0.5), p95: percentile(exact, 0.95) },
      annMs: { p50: percentile(ann, 0.5), p95: percentile(ann, 0.95) },
      recallAt8: overlap.reduce((a, b) => a + b, 0) / overlap.length,
    });
  } finally {
    await api(path, undefined, 'DELETE');
  }
}
console.log(
  JSON.stringify(
    {
      date: new Date().toISOString(),
      qdrant: '1.18.3',
      scope:
        'synthetic index-only; excludes embedding, MySQL, authorization/source checks and generation; not semantic RAG quality',
      reports,
    },
    null,
    2,
  ),
);
