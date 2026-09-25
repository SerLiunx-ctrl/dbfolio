import { useLayoutEffect, type RefObject } from "react";

/** 只移动标签栏，避免 scrollIntoView 同时滚动工作区；兼容祖先 transform 缩放。 */
export function revealActiveTab(strip: HTMLElement, tab: HTMLElement) {
  if (!strip.clientWidth || !strip.offsetWidth) return;
  const viewport = strip.getBoundingClientRect();
  const scale = viewport.width / strip.offsetWidth;
  if (scale <= 0) return;
  const bounds = tab.getBoundingClientRect();
  const left = (bounds.left - viewport.left) / scale - strip.clientLeft;
  const right = (bounds.right - viewport.left) / scale - strip.clientLeft;
  const delta = right - left > strip.clientWidth ? left
    : left < 0 ? left : right > strip.clientWidth ? right - strip.clientWidth : 0;
  if (Math.abs(delta) > 0.5) strip.scrollLeft += delta;
}

export function useActiveTabScroll(ref: RefObject<HTMLDivElement | null>, layoutKey: string, hidden: boolean) {
  useLayoutEffect(() => {
    const strip = ref.current;
    if (!strip || hidden) return;
    const reveal = () => {
      const active = strip.querySelector<HTMLElement>('[data-active-tab="true"]');
      if (active) revealActiveTab(strip, active);
    };
    reveal();
    // 窗口/侧栏尺寸和字体加载会改变可见范围；手动滚动不触发追踪。
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    for (const child of strip.children) observer.observe(child);
    return () => observer.disconnect();
  }, [ref, layoutKey, hidden]);
}
