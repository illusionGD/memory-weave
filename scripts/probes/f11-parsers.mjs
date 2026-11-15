import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 依赖安装在独立实验目录，避免提前改变应用依赖和 lockfile。
if (!process.argv[2]) throw new Error('请传入已安装解析依赖的实验目录。');
const dependencies = createRequire(resolve(process.argv[2], 'package.json'));
const { JSDOM } = await import(pathToFileURL(dependencies.resolve('jsdom')).href);
const { Readability } = await import(
  pathToFileURL(dependencies.resolve('@mozilla/readability')).href
);
const { getDocument } = await import(
  pathToFileURL(dependencies.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href
);
const { default: sharp } = await import(pathToFileURL(dependencies.resolve('sharp')).href);
const pdfAssets = pathToFileURL(dependencies.resolve('pdfjs-dist/package.json'));

const result = {
  node: process.version,
  packages: {
    ...Object.fromEntries(
      ['jsdom', '@mozilla/readability', 'pdfjs-dist'].map((name) => [
        name,
        dependencies(`${name}/package.json`).version,
      ]),
    ),
    sharp: sharp.versions.sharp,
  },
  text: probeText(),
  article: probeArticle(),
  pdf: await probePdf(),
  image: await probeImage(),
  // 独立实验进程的整段峰值，包含模块加载和所有样本，不代表服务容量。
  peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
};
console.log(JSON.stringify(result, null, 2));

/** 检查中文 UTF-8、BOM 和 Markdown 原文能否完整解码。 */
function probeText() {
  const original = '# 星空札记\n\n新地址：星河路八号。\n\n- 保留来源\n- 保留时间\n';
  const bytes = Buffer.from(original.repeat(2000));
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert.equal(text, original.repeat(2000));
  assert.equal(
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from('\uFEFF星空札记')),
    '星空札记',
  );
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.of(0xff)));
  return { characters: text.length, utf8: true, bom: true, invalidUtf8Rejected: true };
}

/** 检查长篇中文正文提取是否保留尾段并排除导航。 */
function probeArticle() {
  const started = performance.now();
  const sentence = '在星空下分享一本书，记住的不只是文字，还有当时的感受。';
  const paragraphs = Array.from(
    { length: 2000 },
    (_, index) => `<p>第${index + 1}段：${sentence.repeat(6)}</p>`,
  ).join('');
  const dom = new JSDOM(
    `<html lang="zh"><head><title>中文长文验证</title></head><body><nav>首页</nav><main><article><h1>中文长文验证</h1>${paragraphs}</article></main></body></html>`,
    { url: 'https://example.org/article' },
  );
  try {
    const parsed = new Readability(dom.window.document).parse();
    assert(parsed.textContent.includes('第2000段：'));
    assert(!parsed.textContent.includes('首页'));
    const content = new JSDOM(parsed.content);
    try {
      assert.equal(content.window.document.querySelectorAll('p').length, 2000);
      return { characters: parsed.textContent.length, paragraphs: 2000, ms: elapsed(started) };
    } finally {
      content.window.close();
    }
  } finally {
    dom.window.close();
  }
}

/** 检查中文 PDF 的逐页定位、文字空页和资源释放接口。 */
async function probePdf() {
  const started = performance.now();
  const loading = getDocument({
    data: new Uint8Array(await readFile(new URL('./fixtures/f11-text.pdf', import.meta.url))),
    useSystemFonts: false,
    isEvalSupported: false,
    cMapUrl: fileURLToPath(new URL('./cmaps/', pdfAssets)),
    cMapPacked: true,
    standardFontDataUrl: fileURLToPath(new URL('./standard_fonts/', pdfAssets)),
  });
  try {
    const pdf = await loading.promise;
    const pages = [];
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str ?? '').join(''));
      page.cleanup();
    }
    assert.equal(pdf.numPages, 13);
    assert(pages.slice(0, 12).every((page, index) => page.includes(`第${index + 1}页`)));
    assert(pages[7].includes('新的收件地址是星河路八号。'));
    assert.equal(pages[12], '');
    return {
      pages: pdf.numPages,
      textPages: pages.filter(Boolean).length,
      textCharacters: pages.reduce((count, page) => count + page.length, 0),
      page8Address: true,
      lastPageNoText: true,
      ms: elapsed(started),
    };
  } finally {
    await loading.destroy();
  }
}

/** 检查长图分区和 EXIF 旋转的几何结果，不评估模型识图效果。 */
async function probeImage() {
  const started = performance.now();
  const image = await sharp(
    Buffer.from(
      '<svg width="1200" height="18000"><rect width="1200" height="9000" fill="blue"/><rect y="9000" width="1200" height="9000" fill="orange"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  const regions = [];
  for (const top of [0, 16_200]) {
    regions.push(
      await sharp(image, { limitInputPixels: 40_000_000 })
        .extract({ left: 0, top, width: 1200, height: 1800 })
        .resize({ width: 800 })
        .png()
        .toBuffer(),
    );
  }
  assert(!regions[0].equals(regions[1]));
  const region = await sharp(regions[0]).metadata();
  assert.equal(region.width, 800);
  assert.equal(region.height, 1200);
  const oriented = await sharp({
    create: { width: 30, height: 60, channels: 3, background: '#ffffff' },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const normalized = await sharp(oriented).rotate().png().toBuffer();
  const metadata = await sharp(normalized).metadata();
  assert.equal(metadata.width, 60);
  assert.equal(metadata.height, 30);
  const formats = [];
  for (const format of ['jpeg', 'png', 'webp']) {
    const encoded = await sharp(normalized).toFormat(format).toBuffer();
    const decoded = await sharp(encoded).metadata();
    assert.equal(decoded.format, format);
    assert.equal(decoded.width, 60);
    assert.equal(decoded.height, 30);
    formats.push(format);
  }
  return {
    original: [1200, 18000],
    crop: [region.width, region.height],
    bottomDistinct: true,
    exifOrientation: true,
    formats,
    ms: elapsed(started),
  };
}

/** 记录一次实验耗时，结果不作为延迟承诺。 */
function elapsed(started) {
  return Math.round(performance.now() - started);
}
