import { createHash } from 'node:crypto';
import { parseArticle } from './article-parser';
import type { ArticleSnapshot } from './article-parser';
import type { MaterialConfiguration } from './material-config';
import { downloadWebResource, WebDownloadError } from './web-download';

interface ArticleDownload {
  sourceUrl: string;
  finalUrl: string | null;
  receivedAt: string;
  hash: string | null;
  content: ArticleSnapshot | null;
  reason: string | null;
  suggestion: string | null;
}

const SHARE_ORIGINAL = '请粘贴正文，或上传正文文件或截图。';

/**
 * 读取分享链接一次，回传取得的原始响应身份与范围，可供持久任务建立快照。
 * @param url 用户分享的网页。
 * @param limits 部署预算。
 * @returns 有界正文、版本哈希与可呈现的获取失败信息。
 */
export async function downloadArticle(
  url: string,
  limits: MaterialConfiguration,
): Promise<ArticleDownload> {
  const result: ArticleDownload = {
    sourceUrl: url,
    finalUrl: null,
    receivedAt: new Date().toISOString(),
    hash: null,
    content: null,
    reason: null,
    suggestion: null,
  };
  try {
    const page = await downloadWebResource(url, limits);
    result.finalUrl = page.url;
    result.receivedAt = new Date().toISOString();
    const contentType = page.contentType ?? '';
    if (page.status < 200 || page.status >= 300) {
      result.reason =
        page.status === 401 || page.status === 403 ? 'restricted' : `http-${page.status}`;
    } else if (!/^text\/html(?:\s*;|$)/iu.test(contentType)) {
      result.reason = 'unsupported-content-type';
    } else {
      result.hash = createHash('sha256').update(page.bytes).digest('hex');
      result.content = parseArticle(page.bytes, new URL(page.url), limits, contentType);
      if (['restricted', 'no-body', 'text-limit'].includes(result.content.status))
        result.reason = result.content.status;
    }
  } catch (error) {
    result.reason = error instanceof WebDownloadError ? error.reason : 'parse-failed';
  }
  if (result.reason) result.suggestion = SHARE_ORIGINAL;
  return result;
}
