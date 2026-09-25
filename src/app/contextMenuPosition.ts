/** 在可视区域内定位菜单，优先从点击位置展开，空间不足时翻转。 */
export function contextMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewport: { left: number; top: number; width: number; height: number },
) {
  const gap = 8;
  const left = viewport.left + gap;
  const top = viewport.top + gap;
  const right = viewport.left + viewport.width - gap;
  const bottom = viewport.top + viewport.height - gap;
  return {
    left: Math.max(left, Math.min(x + width > right ? x - width : x, right - width)),
    top: Math.max(top, Math.min(y + height > bottom ? y - height : y, bottom - height)),
  };
}
