import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  apiResponseSchema,
  terminalActionSchema,
  terminalConnectionViewSchema,
  terminalDispatchSchema,
  terminalReceiptSchema,
  uuidSchema,
} from '../packages/contracts/dist/index.js';

const base = new URL(process.env.TEST_TERMINAL_URL ?? 'http://127.0.0.1:3000');
const id = uuidSchema.parse(process.env.TEST_TERMINAL_ID).toLowerCase();
const secret = process.env.TEST_TERMINAL_SECRET ?? '';
const workspace = process.env.TEST_TERMINAL_WORKSPACE ?? 'local';
const journalRoot = process.env.TEST_TERMINAL_JOURNAL ?? '';
const journal = join(journalRoot, id);
if (
  !['http:', 'https:'].includes(base.protocol) ||
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) && base.protocol !== 'https:')
)
  throw new Error('TEST_TERMINAL_URL 必须为 HTTPS 或本机 HTTP 入口。');
if (!/^[a-f0-9]{64}$/u.test(secret) || !isAbsolute(journalRoot))
  throw new Error('需要设备凭据和绝对路径形式的独立回执目录。');

const shutdown = new AbortController();
process.once('SIGINT', () => shutdown.abort());
process.once('SIGTERM', () => shutdown.abort());
await mkdir(journal, { recursive: true, mode: 0o700 });

/** 设备凭据只发送到指定终端路由。 */
async function call(method, path, input, schema) {
  const response = await fetch(new URL(`/api/terminals/${id}/${path}`, base), {
    method,
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(5_000),
    redirect: 'error',
  });
  if (!response.ok) {
    const error = new Error(`终端请求返回 HTTP ${response.status}。`);
    error.status = response.status;
    throw error;
  }
  return schema.parse(apiResponseSchema.parse(await response.json()).data);
}

/** 回执必须先落盘，以便进程重启后使用旧领取身份核对。 */
async function saveReceipt(dispatch, connectionId) {
  const receipt = terminalReceiptSchema.parse({
    connectionId,
    claimId: dispatch.claimId,
    outcome:
      Date.now() < Date.parse(dispatch.deadlineAt)
        ? { state: 'succeeded', result: dispatch.arguments }
        : { state: 'not-executed' },
  });
  const path = join(journal, `${dispatch.id}.json`);
  const temporary = path + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(receipt));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  if (process.platform !== 'win32') {
    const directory = await open(journal, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

/** 重连优先发送已落盘的回执，服务端按领取身份确认是否有效。 */
async function reconcile(connectionId) {
  for (const name of (await readdir(journal)).sort()) {
    if (!name.endsWith('.json')) continue;
    const actionId = uuidSchema.safeParse(name.slice(0, -5));
    if (!actionId.success) continue;
    const path = join(journal, name);
    const receipt = terminalReceiptSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    await call(
      'PUT',
      `actions/${actionId.data}/receipt`,
      { ...receipt, connectionId },
      terminalActionSchema,
    );
    await rm(path);
  }
}

let connection = null;
while (!shutdown.signal.aborted) {
  try {
    if (!connection)
      connection = await call(
        'POST',
        'connect',
        { workspaceId: workspace, capabilities: ['diagnostic.echo'] },
        terminalConnectionViewSchema,
      );
    const { connectionId } = connection;
    await reconcile(connectionId);
    connection = await call('POST', 'heartbeat', { connectionId }, terminalConnectionViewSchema);
    const dispatch = await call(
      'POST',
      'claim',
      { connectionId },
      terminalDispatchSchema.nullable(),
    );
    if (dispatch && dispatch.tool === 'diagnostic.echo' && dispatch.workspaceId === workspace) {
      await saveReceipt(dispatch, connectionId);
      await reconcile(connectionId);
    }
  } catch (error) {
    if (
      error?.status === 400 ||
      error?.status === 401 ||
      error?.status === 403 ||
      error?.status === 404
    )
      throw error;
    connection = null;
  }
  const interval = connection
    ? Math.max(25, Math.min(1_000, (Date.parse(connection.expiresAt) - Date.now()) / 3))
    : 1_000;
  await delay(interval, undefined, { signal: shutdown.signal }).catch(() => undefined);
}
if (connection)
  await call(
    'POST',
    'disconnect',
    { connectionId: connection.connectionId },
    { parse: (value) => value },
  ).catch(() => undefined);
