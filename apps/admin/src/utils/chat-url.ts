/** 只生成配置中的聊天站点链接；管理项目不导入聊天页面或路由。 */
export function chatUrl(path = '/'): string {
  const base = import.meta.env.PUBLIC_CHAT_URL || '/';
  return new URL(path, new URL(base, window.location.origin)).href;
}
