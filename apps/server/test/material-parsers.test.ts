import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { inspectMaterialImage, renderMaterialImage } from '../src/modules/materials/image-parser';
import { describe, expect, it } from 'vitest';
import { parseArticle } from '../src/modules/materials/article-parser';
import { parsePdfDocument, parseTextDocument } from '../src/modules/materials/document-parser';
import { materialConfigurationSchema } from '../src/modules/materials/material-config';
import { downloadWebResource } from '../src/modules/materials/web-download';

const limits = materialConfigurationSchema.parse({});

describe('材料提取', () => {
  it('保留中文 Markdown 段落，拒绝乱码和超预算原文', () => {
    expect(parseTextDocument(Buffer.from('\uFEFF# 星空\r\n\r\n星河路'), limits)).toEqual([
      { page: null, paragraph: 1, text: '# 星空', status: 'text' },
      { page: null, paragraph: 2, text: '星河路', status: 'text' },
    ]);
    expect(() => parseTextDocument(Uint8Array.of(0xff), limits)).toThrow('invalid-format');
    expect(() =>
      parseTextDocument(Buffer.from('超长'), { ...limits, maxTextCharacters: 1 }),
    ).toThrow('text-limit');
  });

  it('保留 PDF 页码和无文字层页，拒绝超过页数限制的文件', async () => {
    const bytes = await readFile(
      new URL('../../../scripts/probes/fixtures/f11-text.pdf', import.meta.url),
    );
    const parts = await parsePdfDocument(bytes, limits);
    expect(parts).toHaveLength(13);
    expect(parts[7]).toMatchObject({ page: 8, text: expect.stringContaining('星河路八号') });
    expect(parts[12]).toMatchObject({ page: 13, status: 'no-text-layer' });
    await expect(parsePdfDocument(bytes, { ...limits, maxPdfPages: 12 })).rejects.toThrow(
      'page-limit',
    );
  });

  it('提取普通网页结构和公众号懒加载图，不把导航或脚本算作正文', () => {
    const sentence = '这段内容保留文章原文和上下文。'.repeat(8);
    const html = `<title>星空札记</title><nav>首页</nav><article><p>${sentence}</p><p>结尾</p><script>恶意内容</script></article>`;
    expect(parseArticle(html, new URL('https://example.com/a'), limits).paragraphs).toEqual([
      sentence,
      '结尾',
    ]);
    expect(
      parseArticle(
        '<div id="js_content"><p>正文</p><img data-src="/pic.jpg"></div>',
        new URL('https://mp.weixin.qq.com/s/a'),
        limits,
      ),
    ).toMatchObject({
      status: 'article',
      paragraphs: ['正文'],
      imageUrls: ['https://mp.weixin.qq.com/pic.jpg'],
    });
  });

  it('B 站从公开状态读取实际简介，忽略通用页面元数据的宣传文案', () => {
    const html =
      '<meta property="og:description" content="网站宣传">' +
      '<script>window.__INITIAL_STATE__={"videoData":{"title":"星空","desc":"本页简介","pic":"/cover.jpg"}};(function(){})()</script>';
    expect(parseArticle(html, new URL('https://www.bilibili.com/video/BV1'), limits)).toMatchObject(
      {
        status: 'video-page-only',
        title: '星空',
        paragraphs: ['本页简介'],
        imageUrls: ['https://www.bilibili.com/cover.jpg'],
      },
    );
  });

  it('保留知乎访问限制和 B 站页面范围，不把验证页或目录当成正文', () => {
    expect(
      parseArticle(
        '<title>安全验证</title><p>请输入验证码</p>',
        new URL('https://zhuanlan.zhihu.com/p/123'),
        limits,
      ),
    ).toMatchObject({ status: 'restricted', paragraphs: [] });
    expect(
      parseArticle(
        '<title>视频</title><meta property="og:image" content="https://example.com/cover.jpg"><article>合集目录</article>',
        new URL('https://www.bilibili.com/video/BV1'),
        limits,
      ),
    ).toMatchObject({
      status: 'video-page-only',
      paragraphs: [],
      imageUrls: ['https://example.com/cover.jpg'],
    });
  });
});

describe('网页下载地址验证', () => {
  it.each([
    'file:///tmp/material',
    'http://user:password@example.org/',
    'https://example.org:8443/',
    'http://127.1/',
    'http://169.254.169.254/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fc00::1]/',
  ])('拒绝连接 %s', async (url) => {
    await expect(downloadWebResource(url, limits)).rejects.toMatchObject({
      reason: 'unsafe-address',
    });
  });
});

describe('材料图片', () => {
  it('使用 EXIF 校正坐标，局部保留长图尾部', async () => {
    const bytes = await sharp({
      create: { width: 3201, height: 20, channels: 3, background: '#ffffff' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const image = await inspectMaterialImage(bytes, limits);
    expect(image).toMatchObject({ width: 20, height: 3201, format: 'jpeg' });
    expect(image.regions).toHaveLength(3);
    const last = image.regions[2];
    expect(last).toEqual({ left: 0, top: 3200, width: 20, height: 1 });
    const crop = await renderMaterialImage(bytes, limits, last);
    expect(await sharp(crop).metadata()).toMatchObject({ width: 20, height: 1 });
    await expect(inspectMaterialImage(bytes, { ...limits, maxImagePixels: 100 })).rejects.toThrow();
  });
});
