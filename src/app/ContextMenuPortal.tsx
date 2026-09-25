import { createPortal } from "react-dom";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { contextMenuPosition } from "./contextMenuPosition";

/** 所有自定义菜单共用实际尺寸测量，避免底部/右侧溢出。 */
export function ContextMenuSurface({ x, y, className, children }: {
  x: number;
  y: number;
  className: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const viewport = window.visualViewport;
    const reposition = () => {
      const bounds = {
        left: viewport?.offsetLeft ?? 0,
        top: viewport?.offsetTop ?? 0,
        width: viewport?.width ?? window.innerWidth,
        height: viewport?.height ?? window.innerHeight,
      };
      menu.style.maxWidth = `${Math.max(0, bounds.width - 16)}px`;
      menu.style.maxHeight = `${Math.max(0, Math.min(420, bounds.height * 0.7, bounds.height - 16))}px`;
      const rect = menu.getBoundingClientRect();
      const position = contextMenuPosition(x, y, rect.width, rect.height, bounds);
      menu.style.left = `${position.left}px`;
      menu.style.top = `${position.top}px`;
      menu.style.visibility = "visible";
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    observer.observe(menu);
    window.addEventListener("resize", reposition);
    viewport?.addEventListener("resize", reposition);
    viewport?.addEventListener("scroll", reposition);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reposition);
      viewport?.removeEventListener("resize", reposition);
      viewport?.removeEventListener("scroll", reposition);
    };
  }, [x, y]);
  return <div ref={ref} className={className} style={{
    position: "fixed", left: x, top: y, visibility: "hidden",
    minWidth: 0, width: "max-content", overflow: "auto", overscrollBehavior: "contain",
  }}>{children}</div>;
}

/**
 * 将右键菜单渲染到 FluentProvider 内的专用容器：
 * - 脱离界面缩放的 transform 容器，fixed 定位坐标才准确
 * - 仍在 Provider 内，保留 Fluent 主题 CSS 变量
 */
export function ContextMenuPortal({ children }: { children: ReactNode }) {
  const host =
    typeof document === "undefined"
      ? null
      : document.getElementById("dw-overlay-root");
  return createPortal(children, host ?? document.body);
}
