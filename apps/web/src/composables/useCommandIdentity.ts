/** 同一页面内，同一载荷的网络重试沿用命令身份，避免重复创建。 */
export function useCommandIdentity(): (input: unknown) => string {
  let previous = '';
  let id = '';
  return function identify(input: unknown): string {
    const content = JSON.stringify(input);
    if (content !== previous || !id) {
      previous = content;
      id = crypto.randomUUID();
    }
    return id;
  };
}
