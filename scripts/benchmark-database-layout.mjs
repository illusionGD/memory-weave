import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { createConnection } = require('mysql2/promise');
if (!process.env.TEST_DATABASE_URL) throw new Error('必须指定隔离测试用的 TEST_DATABASE_URL。');
const url = new URL(process.env.TEST_DATABASE_URL);
const name = `mw_layout_${randomUUID().replaceAll('-', '')}`;
const connection = await createConnection(url.toString());
const results = [];

/** 运行同一查询多次，丢弃预热结果后报告中位数和 P95。 */
async function measure(label, query) {
  const samples = [];
  for (let i = 0; i < 35; i++) {
    const start = performance.now();
    await connection.query(query);
    if (i >= 5) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const [explain] = await connection.query(`EXPLAIN ANALYZE ${query}`);
  return {
    label,
    medianMs: Number(samples[15].toFixed(3)),
    p95Ms: Number(samples[28].toFixed(3)),
    plan: Object.values(explain[0])[0],
  };
}

try {
  await connection.query(`CREATE DATABASE \`${name}\``);
  await connection.query(`USE \`${name}\``);
  await connection.query('CREATE TABLE digits (n INT PRIMARY KEY)');
  await connection.query('INSERT INTO digits VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)');
  await connection.query(`CREATE TABLE numbers AS SELECT
    a.n + 10*b.n + 100*c.n + 1000*d.n + 10000*e.n + 1 AS n
    FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d CROSS JOIN digits e`);
  for (const size of [10000, 100000]) {
    await connection.query(`CREATE TABLE original_messages (
      id BIGINT PRIMARY KEY, owner_id INT NOT NULL, conversation_id BIGINT NOT NULL,
      sequence INT NOT NULL, body TEXT NOT NULL,
      UNIQUE(owner_id, conversation_id, sequence))`);
    await connection.query(`CREATE TABLE original_segments (
      message_id BIGINT PRIMARY KEY, owner_id INT NOT NULL, run_id BIGINT NOT NULL,
      position INT NOT NULL, UNIQUE(owner_id,run_id,position),
      FOREIGN KEY (message_id) REFERENCES original_messages(id))`);
    await connection.query(`CREATE TABLE merged_messages LIKE original_messages`);
    await connection.query(`ALTER TABLE merged_messages ADD run_id BIGINT NULL,
      ADD position INT NULL, ADD UNIQUE(owner_id,run_id,position)`);
    await connection.query(
      `INSERT INTO original_messages
      SELECT n, 1, CEIL(n/100), MOD(n-1,100)+1, REPEAT('聊天正文',50) FROM numbers WHERE n<=?`,
      [size],
    );
    await connection.query(`INSERT INTO original_segments
      SELECT id,1,CEIL(id/2),1 FROM original_messages WHERE MOD(id,2)=0`);
    await connection.query(`INSERT INTO merged_messages
      SELECT m.*,s.run_id,s.position FROM original_messages m LEFT JOIN original_segments s ON s.message_id=m.id`);
    await connection.query(`CREATE TABLE original_conversations (
      id BIGINT PRIMARY KEY, owner_id INT NOT NULL, title VARCHAR(80),
      version INT NOT NULL DEFAULT 1, UNIQUE(owner_id,id))`);
    await connection.query(`CREATE TABLE original_threads (
      conversation_id BIGINT PRIMARY KEY, owner_id INT NOT NULL, companion_id BIGINT,
      current_run_id BIGINT, UNIQUE(owner_id,conversation_id),
      FOREIGN KEY (conversation_id) REFERENCES original_conversations(id))`);
    await connection.query(`CREATE TABLE merged_conversations LIKE original_conversations`);
    await connection.query(`ALTER TABLE merged_conversations ADD companion_id BIGINT NULL,
      ADD current_run_id BIGINT NULL, ADD chat_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD INDEX(owner_id,chat_enabled,id)`);
    await connection.query(
      'INSERT INTO original_conversations SELECT n,1,CONCAT("会话",n),1 FROM numbers WHERE n<=?',
      [size / 100],
    );
    await connection.query(
      'INSERT INTO original_threads SELECT id,owner_id,1,NULL FROM original_conversations',
    );
    await connection.query(
      'INSERT INTO merged_conversations SELECT c.*,t.companion_id,t.current_run_id,TRUE FROM original_conversations c JOIN original_threads t ON t.conversation_id=c.id',
    );
    const queries = [
      [
        '消息+片段分表',
        'SELECT m.id,m.body,s.run_id,s.position FROM original_messages m LEFT JOIN original_segments s ON s.message_id=m.id AND s.owner_id=m.owner_id WHERE m.owner_id=1 AND m.conversation_id=50 ORDER BY m.sequence DESC LIMIT 20',
      ],
      [
        '片段合入消息',
        'SELECT id,body,run_id,position FROM merged_messages WHERE owner_id=1 AND conversation_id=50 ORDER BY sequence DESC LIMIT 20',
      ],
      [
        '会话+聊天分表',
        'SELECT c.id,c.title,t.current_run_id FROM original_threads t JOIN original_conversations c ON c.id=t.conversation_id AND c.owner_id=t.owner_id WHERE t.owner_id=1 ORDER BY t.conversation_id LIMIT 20',
      ],
      [
        '聊天合入会话',
        'SELECT id,title,current_run_id FROM merged_conversations WHERE owner_id=1 AND chat_enabled=TRUE ORDER BY id LIMIT 20',
      ],
    ];
    const reads = [];
    for (const [label, query] of queries) reads.push(await measure(label, query));
    const writes = [];
    for (const merged of [false, true]) {
      const samples = [];
      for (let i = 0; i < 30; i++) {
        const id = size + i + 1;
        const start = performance.now();
        await connection.beginTransaction();
        if (merged)
          await connection.execute(
            'INSERT INTO merged_messages VALUES (?,1,9999,?,REPEAT("写入",100),?,1)',
            [id, i + 1, id],
          );
        else {
          await connection.execute(
            'INSERT INTO original_messages VALUES (?,1,9999,?,REPEAT("写入",100))',
            [id, i + 1],
          );
          await connection.execute('INSERT INTO original_segments VALUES (?,1,?,1)', [id, id]);
        }
        await connection.commit();
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      writes.push({
        label: merged ? '合并写入' : '分表写入',
        medianMs: Number(samples[15].toFixed(3)),
        p95Ms: Number(samples[28].toFixed(3)),
      });
    }
    results.push({ size, reads, writes });
    for (const table of [
      'original_segments',
      'original_messages',
      'merged_messages',
      'original_threads',
      'original_conversations',
      'merged_conversations',
    ])
      await connection.query(`DROP TABLE ${table}`);
  }
  console.log(
    JSON.stringify({ note: '合成布局实验；不等于完整业务压测或锁竞争验证。', results }, null, 2),
  );
} finally {
  await connection.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await connection.end();
}
