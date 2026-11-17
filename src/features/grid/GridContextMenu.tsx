import { useLayoutEffect, useMemo, type ReactNode } from "react";
import { Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, makeStyles, tokens, type MenuItemProps } from "@fluentui/react-components";

const useStyles = makeStyles({
  surface: {
    zIndex: 1200,
    minWidth: "180px",
    maxWidth: "calc(100vw - 16px)",
    maxHeight: "min(420px, 70vh, calc(100vh - 16px))",
    overflowY: "auto",
    overscrollBehavior: "contain",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: "var(--dw-palette-surface, var(--colorNeutralBackground1))",
  },
});

/** 网格右键菜单独立于工作区缩放，根菜单与子菜单共用 Fluent 的焦点、关闭和定位逻辑。 */
export function GridContextMenu({ x, y, onClose, children }: {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const styles = useStyles();
  const target = useMemo(() => ({
    getBoundingClientRect: () => ({ x, y, top: y, left: x, bottom: y, right: x, width: 0, height: 0 }),
  }), [x, y]);
  useLayoutEffect(() => {
    // 在 Fluent 的 open effect 移动焦点前记录来源；打开 SQL 弹窗等新界面后不抢回焦点。
    const previous = document.activeElement;
    return () => {
      requestAnimationFrame(() => {
        if (document.activeElement === document.body && previous instanceof HTMLElement && previous.isConnected) {
          previous.focus({ preventScroll: true });
        }
      });
    };
  }, []);
  return <Menu open hasIcons closeOnScroll
    positioning={{ target, strategy: "fixed", position: "below", align: "start", offset: 0, autoSize: true, overflowBoundaryPadding: 8, fallbackPositions: ["above-start", "below-end", "above-end"] }}
    onOpenChange={(_, data) => { if (!data.open) onClose(); }}>
    <MenuPopover className={`${styles.surface} dw-grid-context-menu`} onContextMenu={event => { event.preventDefault(); onClose(); }}>
      <MenuList aria-label="网格右键菜单">{children}</MenuList>
    </MenuPopover>
  </Menu>;
}

export function GridMenuSubmenu({ label, icon, children }: { label: string; icon: MenuItemProps["icon"]; children: ReactNode }) {
  const styles = useStyles();
  // 各层保留独立默认 Portal，Fluent 的 virtual-parent 链才能将子叶点击识别为菜单内部。
  return <Menu hasIcons hoverDelay={150} closeOnScroll
    positioning={{ strategy: "fixed", autoSize: true, overflowBoundaryPadding: 8 }}>
    <MenuTrigger disableButtonEnhancement><MenuItem icon={icon}>{label}</MenuItem></MenuTrigger>
    <MenuPopover className={`${styles.surface} dw-grid-context-submenu`}>
      <MenuList aria-label={label}>{children}</MenuList>
    </MenuPopover>
  </Menu>;
}
