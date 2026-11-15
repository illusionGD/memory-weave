import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/** 只探测固定的公开样本，不接受任意抓取地址。 */
const SAMPLES = [
  ['blog', 'https://nodejs.org/en/blog/release/v22.23.0'],
  ['bilibili', 'https://www.bilibili.com/video/BV17SzeBsEix/'],
  ['bilibili-second', 'https://www.bilibili.com/video/BV1EmzeBdEJu/'],
  ['zhihu', 'https://zhuanlan.zhihu.com/p/656646499'],
  ['zhihu-second', 'https://zhuanlan.zhihu.com/p/20734615'],
  ['wechat', 'https://mp.weixin.qq.com/s/slGMhoPhAQgkRE58GZBnvQ'],
];
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'mw-public-links-'));
const results = [];

try {
  for (const [name, url] of SAMPLES) results.push(await probe(name, url));
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}

/** 请求公开样本并输出取得范围，不执行脚本、不跟随跳转、不保留正文。 */
async function probe(name, url) {
  const path = join(directory, name);
  let status;
  let failure = null;
  try {
    const response = await run(
      'curl',
      [
        '-q',
        '--silent',
        '--show-error',
        '--compressed',
        '--proto',
        '=https',
        '--max-time',
        '15',
        '--max-filesize',
        '5242880',
        '--user-agent',
        'Mozilla/5.0 (compatible; MemoryWeave/0.1; public-page-reading)',
        '--output',
        path,
        '--write-out',
        '%{http_code}',
        url,
      ],
      { timeout: 18_000, maxBuffer: 16_384 },
    );
    status = Number(response.stdout);
  } catch (error) {
    status = Number(error.stdout) || 0;
    failure = /CONNECT tunnel failed, response 403/i.test(error.stderr ?? '')
      ? 'proxy_connect_denied'
      : 'request_failed';
  }
  const body = await readFile(path).catch(() => Buffer.alloc(0));
  const html = body.toString('utf8');
  const state = html.match(/window\.__INITIAL_STATE__=(\{.*?\});\(function/);
  let video = null;
  if (state) {
    try {
      const data = JSON.parse(state[1]).videoData;
      if (data && typeof data.desc === 'string')
        video = { descriptionCharacters: data.desc.length, coverReference: Boolean(data.pic) };
    } catch {
      failure = 'unrecognized_page_state';
    }
  }
  return {
    name,
    url,
    status,
    failure,
    decodedBytes: body.length,
    hasTitle: /<title[^>]*>[^<]+<\/title>/i.test(html),
    verificationPage: /id=["']zh-zse-ck["']/.test(html),
    video,
  };
}
