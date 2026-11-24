import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import { z } from 'zod';
import type { MaterialConfiguration } from './material-config';

const videoStateSchema = z.object({
  videoData: z.object({ title: z.string(), desc: z.string(), pic: z.string().optional() }),
});

export interface ArticleSnapshot {
  title: string;
  paragraphs: string[];
  imageUrls: string[];
  status: 'article' | 'video-page-only' | 'restricted' | 'no-body' | 'text-limit';
}

/**
 * 提取实际返回的 HTML，不执行脚本或发起资源请求。
 * @param html 经获取层限制大小的 HTML。
 * @param url 实际响应地址。
 * @param limits 部署预算。
 * @param contentType 响应的 HTML 类型和字符集，供原始字节解码。
 * @returns 结构化快照，配图地址需由获取层重新校验后才能存储。
 */
export function parseArticle(
  html: string | Buffer,
  url: URL,
  limits: MaterialConfiguration,
  contentType = 'text/html',
): ArticleSnapshot {
  if (Buffer.byteLength(html) > limits.maxWebBytes) throw new RangeError('web-byte-limit');
  const dom = new JSDOM(html, { url: url.href, contentType, virtualConsole: new VirtualConsole() });
  try {
    const document = dom.window.document;
    const host = url.hostname;
    const snapshot: ArticleSnapshot = {
      title: document.title.trim().slice(0, 512),
      paragraphs: [],
      imageUrls: [],
      status: 'no-body',
    };
    const metadata = (key: string): string =>
      document
        .querySelector(`meta[property="${key}"], meta[name="${key}"]`)
        ?.getAttribute('content')
        ?.trim() ?? '';

    if (
      (host === 'bilibili.com' || host.endsWith('.bilibili.com')) &&
      url.pathname.startsWith('/video/')
    ) {
      const video = bilibiliVideoState(document);
      snapshot.title = (video?.title || metadata('og:title') || snapshot.title).slice(0, 512);
      const description = video?.desc.trim() ?? '';
      snapshot.imageUrls = imageReferences(url, [video?.pic || metadata('og:image')]);
      if (description && description.length <= limits.maxTextCharacters)
        snapshot.paragraphs = [description];
      snapshot.status =
        description.length > limits.maxTextCharacters ? 'text-limit' : 'video-page-only';
      return snapshot;
    }

    const wechat = host === 'mp.weixin.qq.com';
    const zhihu = host === 'zhihu.com' || host.endsWith('.zhihu.com');
    if (
      (wechat || zhihu) &&
      (document.querySelector('#js_verify, #js_pc_wechat, #zh-zse-ck') ||
        /访问受限|环境异常|安全验证|登录知乎|请输入验证码/u.test(snapshot.title))
    ) {
      return { ...snapshot, status: 'restricted' };
    }

    let body: Element | null;
    if (wechat) {
      body = document.querySelector('#js_content');
    } else if (zhihu) {
      const articleId = /^\/p\/(\d+)\/?$/u.test(url.pathname);
      const answerId = /\/answer\/(\d+)\/?$/u.exec(url.pathname)?.[1];
      body = articleId
        ? document.querySelector('.Post-RichText, article .RichText')
        : answerId
          ? document.querySelector(
              `[data-zop*='"itemId":${answerId},'] .RichText, [data-answer-id="${answerId}"] .RichText`,
            )
          : null;
    } else {
      const article = new Readability(document, {
        charThreshold: 40,
        maxElemsToParse: 50_000,
        serializer: (articleBody) => articleBody,
      }).parse();
      body = article?.content instanceof dom.window.Element ? article.content : null;
      if (article?.title) snapshot.title = article.title.slice(0, 512);
    }
    if (!body) return snapshot;

    for (const element of body.querySelectorAll('script, style, noscript, template, iframe'))
      element.remove();
    for (const element of body.querySelectorAll('br')) element.replaceWith('\n');
    for (const element of body.querySelectorAll(
      'p, h1, h2, h3, h4, h5, h6, li, blockquote, div, section',
    ))
      element.append('\n');
    const paragraphs = (body.textContent ?? '')
      .split('\n')
      .map((part) => part.trim())
      .filter(Boolean);
    if (paragraphs.join('\n').length > limits.maxTextCharacters)
      return { ...snapshot, status: 'text-limit' };
    snapshot.paragraphs = paragraphs;
    snapshot.imageUrls = imageReferences(
      url,
      Array.from(
        body.querySelectorAll('img'),
        (img) => img.getAttribute('data-src') || img.getAttribute('src') || '',
      ),
    );
    snapshot.status = paragraphs.length ? 'article' : 'no-body';
    return snapshot;
  } finally {
    dom.window.close();
  }
}

/** 规范化候选配图地址，地址校验与流量预算由实际获取层执行。 */
function imageReferences(base: URL, references: string[]): string[] {
  const urls = new Set<string>();
  for (const reference of references) {
    if (!reference.trim()) continue;
    try {
      const url = new URL(reference, base);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      url.hash = '';
      urls.add(url.href);
    } catch {
      continue;
    }
  }
  return [...urls];
}

/** 只读取视频页状态里的 JSON 字段，不解释页面 JavaScript。 */
function bilibiliVideoState(
  document: Document,
): z.infer<typeof videoStateSchema>['videoData'] | undefined {
  for (const script of document.querySelectorAll('script:not([src])')) {
    const source = script.textContent ?? '';
    const assignment = /window\.__INITIAL_STATE__\s*=\s*/u.exec(source);
    if (!assignment) continue;
    const start = assignment.index + assignment[0].length;
    const end = source.indexOf(';(function', start);
    if (end < 0) continue;
    const serialized = source.slice(start, end);
    try {
      const state = videoStateSchema.safeParse(JSON.parse(serialized) as unknown);
      if (state.success) return state.data.videoData;
    } catch {
      continue;
    }
  }
}
