import type { MaterialPart, MaterialUpload } from '@memory-weave/contracts';
import { downloadArticle } from './article-download';
import { parsePdfDocument, parseTextDocument } from './document-parser';
import { downloadWebResource } from './web-download';
import type { ImageRegion } from './image-parser';
import { inspectMaterialImage } from './image-parser';
import type { MaterialConfiguration } from './material-config';

/** 上传提取和网页获取共享同一独立进程边界。 */
export type MaterialOperation =
  | { kind: 'upload'; format: MaterialUpload['kind']; bytes: Uint8Array }
  | { kind: 'web'; url: string };
export type MaterialOperationResult =
  | { kind: 'upload'; parts: MaterialPart[] }
  | {
      kind: 'web';
      article: Awaited<ReturnType<typeof downloadArticle>>;
      images: { bytes: Uint8Array; regions: ImageRegion[] }[];
      incompleteImages: boolean;
    };

/** 在独立线程中提取材料，不访问应用数据库。 */
export async function runMaterialOperation(
  operation: MaterialOperation,
  limits: MaterialConfiguration,
): Promise<MaterialOperationResult> {
  if (operation.kind === 'web') {
    const article = await downloadArticle(operation.url, limits);
    const references = article.content?.imageUrls ?? [];
    const images: { bytes: Uint8Array; regions: ImageRegion[] }[] = [];
    let remaining = limits.maxWebImageBytes;
    let incompleteImages = references.length > limits.maxWebImages;
    const deadline = Date.now() + Math.min(4000, limits.webTimeoutMs);
    for (const url of references.slice(0, limits.maxWebImages)) {
      const available = Math.min(remaining, limits.maxWebBytes, limits.maxFileBytes);
      const timeout = deadline - Date.now();
      if (!available || timeout < 100) {
        incompleteImages = true;
        break;
      }
      try {
        const response = await downloadWebResource(url, {
          ...limits,
          maxWebBytes: available,
          webTimeoutMs: timeout,
        });
        if (!response.bytes.length) throw new Error('missing-image');
        const image = await inspectMaterialImage(response.bytes, limits);
        remaining -= response.bytes.length;
        images.push({ bytes: response.bytes, regions: image.regions });
      } catch {
        incompleteImages = true;
      }
    }
    return { kind: 'web', article, images, incompleteImages };
  }
  if (
    operation.format === 'text' ||
    operation.format === 'markdown' ||
    operation.format === 'pdf'
  ) {
    const parts =
      operation.format === 'pdf'
        ? await parsePdfDocument(operation.bytes, limits)
        : parseTextDocument(operation.bytes, limits);
    return {
      kind: 'upload',
      parts: parts.map((part, index) => ({
        position: index + 1,
        page: part.page,
        status: part.status,
        text: part.text || null,
        region: null,
      })),
    };
  }
  const image = await inspectMaterialImage(Buffer.from(operation.bytes), limits);
  if (image.format !== operation.format) throw new Error('image-format');
  return {
    kind: 'upload',
    parts: image.regions.map((region, index) => ({
      position: index + 1,
      page: null,
      status: 'image',
      text: null,
      region,
    })),
  };
}
