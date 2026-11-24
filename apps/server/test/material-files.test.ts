import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { materialConfigurationSchema } from '../src/modules/materials/material-config';
import { MaterialFiles } from '../src/modules/materials/material-files';

it('原件持久化后可重新读取，跨 owner、缺失及损坏不能返回成功', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mw-material-files-'));
  try {
    const owner = randomUUID();
    const limits = materialConfigurationSchema.parse({});
    const files = new MaterialFiles(root, limits);
    const bytes = Buffer.from('星空');
    const first = await files.save(owner, bytes);
    const second = await files.save(owner, bytes);
    expect(second.fileId).not.toBe(first.fileId);
    expect(second.hash).toBe(first.hash);
    const reopened = new MaterialFiles(root, limits);
    await expect(reopened.read(owner, first)).resolves.toEqual(bytes);
    await expect(reopened.read(randomUUID(), first)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(reopened.read(owner, { ...first, fileId: '../invalid' })).rejects.toThrow(
      'invalid-material-file-id',
    );

    const directory = join(root, 'materials', owner);
    expect((await readdir(directory)).sort()).toEqual([first.fileId, second.fileId].sort());
    await writeFile(join(directory, first.fileId), '星河');
    await expect(reopened.read(owner, first)).rejects.toThrow('material-file-checksum');
    await reopened.remove(owner, first.fileId);
    await expect(reopened.read(owner, first)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(reopened.read(owner, second)).resolves.toEqual(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
