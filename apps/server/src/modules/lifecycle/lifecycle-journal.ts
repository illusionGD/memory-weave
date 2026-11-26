import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { lifecycleCommandSchema, uuidSchema, positiveIntegerSchema } from '@memory-weave/contracts';
import { z } from 'zod';
import { SERVER_CONFIG } from '../../config';
import type { RuntimeConfig } from '../../config';

const id = { requestId: uuidSchema, conversationId: uuidSchema };
const journalActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('lifecycle'), command: lifecycleCommandSchema }),
  z.strictObject({
    kind: z.literal('leave'),
    ...id,
    membershipId: uuidSchema,
    actor: z.enum(['owner', 'companion']),
  }),
  z.strictObject({ kind: z.literal('close'), ...id }),
  z.strictObject({ kind: z.literal('deny_invitations'), ...id }),
  z.strictObject({ kind: z.literal('revoke_terminal'), terminalId: uuidSchema }),
  z.strictObject({
    kind: z.literal('disable_terminal_grant'),
    grantId: uuidSchema,
    terminalId: uuidSchema,
    version: positiveIntegerSchema,
  }),
  z.strictObject({
    kind: z.literal('revoke_history'),
    ...id,
    shareId: uuidSchema,
    membershipId: uuidSchema,
    startSequence: positiveIntegerSchema,
    endSequence: positiveIntegerSchema,
  }),
]);
const checksum = z.string().regex(/^[0-9a-f]{64}$/);
const journalRecordSchema = z.strictObject({
  format: z.literal(1),
  ownerId: uuidSchema,
  action: journalActionSchema,
  digest: checksum,
});
export type JournalAction = z.infer<typeof journalActionSchema>;
export type JournalRecord = z.infer<typeof journalRecordSchema>;

/** 保存独立于业务快照的最小限制。记录不含正文、模型密钥或附件。 */
@Injectable()
export class LifecycleJournal {
  /** 部署时单独挂载的限制日志；测试应用可显式设置临时路径。 */
  constructor(@Inject(SERVER_CONFIG) private readonly config: RuntimeConfig) {}

  /** 已校验的限制先同步写入独立日志，再允许主库事务提交。 */
  async append(ownerId: string, action: JournalAction): Promise<void> {
    const directory = this.config.lifecycleJournalDir;
    if (!directory) return;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const value = { format: 1 as const, ownerId, action };
    const record = journalRecordSchema.parse({ ...value, digest: journalDigest(value) });
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    const file = await open(journalPath(directory), 'a', 0o600);
    try {
      const result = await file.write(bytes);
      if (result.bytesWritten !== bytes.length) throw new Error('生命周期日志记录未完整写入。');
      await file.sync();
    } finally {
      await file.close();
    }
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
}

/** 从独立路径读取和校验全部限制记录，拒绝损坏或不完整的字节。 */
export async function readLifecycleJournal(directory: string, allowEmpty = false) {
  const raw = await readFile(journalPath(directory)).catch((error: NodeJS.ErrnoException) => {
    if (allowEmpty && error.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  });
  if (raw.length && raw.at(-1) !== 10) throw new Error('生命周期日志末尾不完整。');
  const records = raw
    .toString('utf8')
    .split('\n')
    .slice(0, -1)
    .map((line) => {
      const row = journalRecordSchema.parse(JSON.parse(line));
      const { digest, ...value } = row;
      if (journalDigest(value) !== digest) throw new Error('生命周期日志校验失败。');
      return row;
    });
  return { records, raw };
}

/** 核对日志满足业务快照中固定的独立日志前缀。 */
export function verifyJournalPrefix(raw: Buffer, snapshotBytes: number, snapshotHash: string) {
  if (raw.length < snapshotBytes || digestBytes(raw.subarray(0, snapshotBytes)) !== snapshotHash)
    throw new Error('生命周期日志缺少备份已知限制，恢复已停止。');
}

/** 生成独立权限日志的约定路径。 */
export function journalPath(directory: string) {
  return join(directory, 'restrictions.jsonl');
}

/** 返回清单和日志使用的 SHA-256。 */
export function digestBytes(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 按固定字段顺序校验行内容。 */
function journalDigest(value: Omit<JournalRecord, 'digest'>) {
  return digestBytes(JSON.stringify(value));
}
