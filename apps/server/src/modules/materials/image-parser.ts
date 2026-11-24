import sharp from 'sharp';
import { hasPngAnimationControl } from '../shared/image-formats';
import type { MaterialConfiguration } from './material-config';

const FORMATS = ['jpeg', 'png', 'webp'] as const;
const MODEL_EDGE = 1600;

export interface ImageRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 区域采用 EXIF 校正后的原件像素坐标。 */
export interface MaterialImage {
  format: (typeof FORMATS)[number];
  width: number;
  height: number;
  regions: ImageRegion[];
}

/**
 * 检查并解码 JPEG/PNG/WebP，按模型输入尺寸划分原件区域。
 * @param bytes 完整原件字节。
 * @param limits 部署预算。
 * @returns 原件格式、校正后的尺寸和可回查区域。
 */
export async function inspectMaterialImage(
  bytes: Buffer,
  limits: MaterialConfiguration,
): Promise<MaterialImage> {
  if (bytes.length > limits.maxFileBytes) throw new RangeError('image-byte-limit');
  const decoder = sharp(bytes, { limitInputPixels: limits.maxImagePixels, failOn: 'warning' });
  const metadata = await decoder.metadata();
  const format = FORMATS.find((supported) => supported === metadata.format);
  if (!format || (metadata.pages ?? 1) > 1 || (format === 'png' && hasPngAnimationControl(bytes)))
    throw new Error('unsupported-image');
  const { width, height } = metadata.autoOrient;
  if (!width || !height) throw new Error('invalid-image-dimensions');
  await decoder.stats();

  const regions: ImageRegion[] = [];
  for (let top = 0; top < height; top += MODEL_EDGE) {
    for (let left = 0; left < width; left += MODEL_EDGE) {
      regions.push({
        left,
        top,
        width: Math.min(MODEL_EDGE, width - left),
        height: Math.min(MODEL_EDGE, height - top),
      });
    }
  }
  return { format, width, height, regions };
}

/**
 * 生成无元数据的模型图像；服务端从已授权的原件和区域调用。
 * @param bytes 完整原件字节。
 * @param limits 部署预算。
 * @param region 指定校正坐标的局部；省略时生成整图概览。
 * @param edge 输出图像最长边上限。
 * @returns 固定 JPEG 编码的图像数据。
 */
export async function renderMaterialImage(
  bytes: Buffer,
  limits: MaterialConfiguration,
  region?: ImageRegion,
  edge = MODEL_EDGE,
): Promise<Buffer> {
  if (bytes.length > limits.maxFileBytes) throw new RangeError('image-byte-limit');
  const image = sharp(bytes, {
    limitInputPixels: limits.maxImagePixels,
    failOn: 'warning',
  }).autoOrient();
  if (region) image.extract(region);
  return image
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85 })
    .toBuffer();
}
