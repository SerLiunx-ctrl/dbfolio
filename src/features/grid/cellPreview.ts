// 仅限制网格中的单行展示文本；编辑、复制、详情和导出继续使用原始值。
export function cellPreview(text: string): string {
  if (text.length <= 256) return text;
  // 不在 UTF-16 代理对中间切断表情等字符。
  const end = /[\uD800-\uDBFF]/.test(text[255]) ? 255 : 256;
  return `${text.slice(0, end)}…`;
}
