import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { IncomingMessage } from 'node:http';
import type { MaterialConfiguration } from './material-config';

const INTERNAL = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['168.63.129.16', 32],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  INTERNAL.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  INTERNAL.addSubnet(address, prefix, 'ipv6');
const GLOBAL_IPV6 = new BlockList();
GLOBAL_IPV6.addSubnet('2000::', 3, 'ipv6');

export class WebDownloadError extends Error {
  constructor(
    readonly reason:
      'unsafe-address' | 'redirect-limit' | 'byte-limit' | 'encoding' | 'timeout' | 'network',
  ) {
    super(reason);
  }
}

export interface DownloadedWebResource {
  url: string;
  status: number;
  contentType: string | null;
  bytes: Buffer;
}

/**
 * 仅从公开 HTTP(S) 地址读取有界响应；每次跳转重新解析并锁定连接地址。
 * @param source 用户分享或正文引用的 URL。
 * @param limits 部署预算。
 * @returns 末跳状态、地址和响应数据。
 */
export async function downloadWebResource(
  source: string,
  limits: MaterialConfiguration,
): Promise<DownloadedWebResource> {
  const signal = AbortSignal.timeout(limits.webTimeoutMs);
  let url = parseUrl(source);
  try {
    for (let redirects = 0; ; redirects++) {
      const response = await openResponse(url, signal);
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.destroy();
        if (redirects >= limits.maxRedirects) throw new WebDownloadError('redirect-limit');
        url = parseUrl(response.headers.location, url);
        continue;
      }
      try {
        if (status < 200 || status >= 300)
          return { url: url.href, status, contentType: null, bytes: Buffer.alloc(0) };
        return {
          url: url.href,
          status,
          contentType: response.headers['content-type'] ?? null,
          bytes: await readBody(response, limits.maxWebBytes, signal),
        };
      } finally {
        response.destroy();
      }
    }
  } catch (error) {
    if (error instanceof WebDownloadError) throw error;
    throw new WebDownloadError(signal.aborted ? 'timeout' : 'network');
  }
}

/** 同时约束线上和解压后的字节数，并在超时时关闭整个管道。 */
async function readBody(
  response: IncomingMessage,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (Number(response.headers['content-length']) > limit) throw new WebDownloadError('byte-limit');
  const encoding = response.headers['content-encoding']?.toLowerCase() ?? 'identity';
  const codecs = new Map([
    ['gzip', createGunzip],
    ['deflate', createInflate],
    ['br', createBrotliDecompress],
  ]);
  const codec = codecs.get(encoding);
  if (encoding !== 'identity' && !codec) throw new WebDownloadError('encoding');
  let transferred = 0;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      transferred += chunk.length;
      if (transferred > limit) done(new WebDownloadError('byte-limit'));
      else done(null, chunk);
    },
  });
  let total = 0;
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      total += chunk.length;
      if (total > limit) {
        done(new WebDownloadError('byte-limit'));
        return;
      }
      chunks.push(chunk);
      done();
    },
  });
  if (codec) await pipeline(response, bounded, codec(), output, { signal });
  else await pipeline(response, bounded, output, { signal });
  return Buffer.concat(chunks, total);
}

/** 禁止凭据、非标准端口与无法建立安全网络连接的协议。 */
function parseUrl(value: string, base?: URL): URL {
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password)
      throw new Error();
    url.hash = '';
    return url;
  } catch {
    throw new WebDownloadError('unsafe-address');
  }
}

/** DNS 和连接共享同一总时限，且禁用跨请求连接复用。 */
async function openResponse(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  const family = isIP(host);
  const candidates = family
    ? [{ address: host, family }]
    : await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
        const abort = (): void => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        lookup(host, allAddresses)
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', abort));
        if (signal.aborted) abort();
      });
  const candidate = candidates[0];
  if (
    !candidate ||
    candidates.some(({ address, family }) =>
      family === 4
        ? INTERNAL.check(address, 'ipv4')
        : !GLOBAL_IPV6.check(address, 'ipv6') || INTERNAL.check(address, 'ipv6'),
    )
  )
    throw new WebDownloadError('unsafe-address');

  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const incoming = request(
      url,
      {
        agent: false,
        signal,
        family: candidate.family,
        lookup: (_name, _options, callback) => callback(null, candidate.address, candidate.family),
        headers: {
          'accept-encoding': 'gzip, deflate, br',
          'user-agent': 'memory-weave-materials/1',
        },
      },
      resolve,
    );
    incoming.once('error', reject);
    incoming.end();
  });
}

const allAddresses = { all: true } as const;
