/**
 * 检测 PNG 数据是否包含动画控制块。
 *
 * PNG 解码器可能只暴露首帧，因此直接检查有界的块结构。
 * @param bytes 已通过 PNG 格式检测的原件字节。
 * @returns 原件是否声明了动画控制块。
 */
export function hasPngAnimationControl(bytes: Buffer): boolean {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') return true;
    if (length > bytes.length - offset - 12) return false;
    offset += length + 12;
  }
  return false;
}
