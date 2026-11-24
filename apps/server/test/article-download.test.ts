import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadArticle } from '../src/modules/materials/article-download';
import { materialConfigurationSchema } from '../src/modules/materials/material-config';
import { downloadWebResource } from '../src/modules/materials/web-download';

const { request, lookup } = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }));
vi.mock('node:https', () => ({ request }));
vi.mock('node:dns/promises', () => ({ lookup }));

const limits = materialConfigurationSchema.parse({});

beforeEach(() => {
  request.mockReset();
  lookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

/** 模拟仅在 DNS 地址固定后才建立连接的 HTTP 响应。 */
function reply(
  statusCode: number,
  headers: Record<string, string>,
  body: Buffer = Buffer.alloc(0),
): void {
  request.mockImplementationOnce((_url, options, callback) => {
    const outgoing = new EventEmitter();
    return Object.assign(outgoing, {
      end: () => {
        options.lookup('', {}, (error: unknown, address: string, family: number) => {
          expect(error).toBeNull();
          expect([address, family]).toEqual(['93.184.216.34', 4]);
        });
        callback(
          Object.assign(Readable.from([body], { objectMode: false }), { statusCode, headers }),
        );
      },
    });
  });
}

describe('网页请求和快照状态', () => {
  it('每跳解析并绑定地址，跳转到内网时在连接前失败', async () => {
    reply(302, { location: 'https://internal.example/a' });
    lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    lookup.mockResolvedValueOnce([{ address: '10.1.2.3', family: 4 }]);
    await expect(downloadWebResource('https://example.org', limits)).rejects.toMatchObject({
      reason: 'unsafe-address',
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('限制解压后的体积', async () => {
    reply(200, { 'content-encoding': 'gzip' }, gzipSync('a'.repeat(1024)));
    await expect(
      downloadWebResource('https://example.org', { ...limits, maxWebBytes: 128 }),
    ).rejects.toMatchObject({ reason: 'byte-limit' });
  });

  it('HTTP 验证拒绝返回正文或截图提示', async () => {
    reply(403, { 'content-type': 'text/html' });
    await expect(downloadArticle('https://mp.weixin.qq.com/s/a', limits)).resolves.toMatchObject({
      reason: 'restricted',
      suggestion: '请粘贴正文，或上传正文文件或截图。',
      content: null,
    });
  });

  it('解压 HTML 后保存稳定哈希和实际取得的正文', async () => {
    const page = gzipSync(Buffer.from('<div id="js_content"><p>星河路八号</p></div>'));
    for (let i = 0; i < 2; i++)
      reply(200, { 'content-encoding': 'gzip', 'content-type': 'text/html; charset=utf-8' }, page);
    const first = await downloadArticle('https://mp.weixin.qq.com/s/a', limits);
    const second = await downloadArticle('https://mp.weixin.qq.com/s/a', limits);
    expect(first).toMatchObject({
      reason: null,
      suggestion: null,
      content: { status: 'article', paragraphs: ['星河路八号'] },
    });
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.hash).toBe(first.hash);
  });
});
