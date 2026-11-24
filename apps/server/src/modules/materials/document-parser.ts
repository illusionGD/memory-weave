import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import type { MaterialConfiguration } from './material-config';

/** 原件位置采用一基页码和段落序号。 */
export interface DocumentPart {
  page: number | null;
  paragraph: number;
  text: string;
  status: 'text' | 'no-text-layer';
}

export class DocumentParseError extends Error {
  constructor(
    readonly reason: 'too-large' | 'invalid-format' | 'empty' | 'page-limit' | 'text-limit',
  ) {
    super(reason);
  }
}

/**
 * 提取 UTF-8 文档的非空段落，保留 Markdown 原文和稳定顺序。
 * @param bytes 完整原件字节。
 * @param limits 部署预算。
 * @returns 可以定位的文字段落。
 */
export function parseTextDocument(
  bytes: Uint8Array,
  limits: MaterialConfiguration,
): DocumentPart[] {
  if (bytes.byteLength > limits.maxFileBytes) throw new DocumentParseError('too-large');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DocumentParseError('invalid-format');
  }
  // 文本原件排除二进制控制字符，保留常见换行和制表符。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text))
    throw new DocumentParseError('invalid-format');
  if (text.length > limits.maxTextCharacters) throw new DocumentParseError('text-limit');
  const paragraphs = text
    .replace(/\r\n?/gu, '\n')
    .split(/\n(?:[^\S\n]*\n)+/u)
    .filter((part) => part.trim());
  if (!paragraphs.length) throw new DocumentParseError('empty');
  return paragraphs.map((part, index) => ({
    page: null,
    paragraph: index + 1,
    text: part,
    status: 'text',
  }));
}

/**
 * 提取 PDF 文字层；空页保留在结果中，含图的页面仍仅表示已提取文字。
 * @param bytes 完整原件字节，复制后交给 PDF.js，保留调用方的缓冲区。
 * @param limits 部署预算。
 * @returns 逐页文字与空页状态。
 */
export async function parsePdfDocument(
  bytes: Uint8Array,
  limits: MaterialConfiguration,
): Promise<DocumentPart[]> {
  if (bytes.byteLength > limits.maxFileBytes) throw new DocumentParseError('too-large');
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-')
    throw new DocumentParseError('invalid-format');

  const { getDocument } = await import(/* webpackIgnore: true */ 'pdfjs-dist/legacy/build/pdf.mjs');
  // Node 在已安装依赖旁查找 PDF 字体与字符映射，开发和生产使用相同资源。
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const loading = getDocument({
    data: Uint8Array.from(bytes),
    stopAtErrors: true,
    verbosity: 0,
    useSystemFonts: false,
    useWasm: false,
    cMapUrl: join(root, 'cmaps') + sep,
    standardFontDataUrl: join(root, 'standard_fonts') + sep,
  });

  try {
    const pdf = await loading.promise;
    if (pdf.numPages > limits.maxPdfPages) throw new DocumentParseError('page-limit');
    const parts: DocumentPart[] = [];
    let total = 0;
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join('')
        .trim();
      page.cleanup();
      total += text.length;
      if (total > limits.maxTextCharacters) throw new DocumentParseError('text-limit');
      parts.push({ page: index, paragraph: 1, text, status: text ? 'text' : 'no-text-layer' });
    }
    return parts;
  } catch (error) {
    if (error instanceof DocumentParseError) throw error;
    throw new DocumentParseError('invalid-format');
  } finally {
    await loading.destroy();
  }
}
