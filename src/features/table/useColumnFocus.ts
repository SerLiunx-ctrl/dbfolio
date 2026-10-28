import { useEffect, useRef, useState } from "react";
import type { ColumnMeta } from "../../ipc/types";

export interface ColumnFocusRequest { name: string }

export function useColumnFocus(request: ColumnFocusRequest | null | undefined, active: boolean, columns: ColumnMeta[]) {
  const rootRef = useRef<HTMLDivElement>(null);
  const handled = useRef<ColumnFocusRequest | null>(null);
  const [highlight, setHighlight] = useState<ColumnFocusRequest | null>(null);
  useEffect(() => {
    if (!active || !request) { setHighlight(null); return; }
    if (handled.current === request) return;
    // 用元数据名称逐项匹配，不将含引号、点号或方括号的列名插入 CSS 选择器。
    const row = Array.from(rootRef.current?.querySelectorAll<HTMLTableRowElement>("tr[data-column-name]") ?? [])
      .find(element => element.dataset.columnName === request.name);
    if (!row) return;
    handled.current = request;
    if (rootRef.current) rootRef.current.scrollLeft = 0;
    row.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    // 焦点落在整行，不进入字段编辑控件；只读会话同样可定位。
    row.tabIndex = -1;
    row.focus({ preventScroll: true });
    setHighlight(request);
  }, [request, active, columns]);
  useEffect(() => {
    if (!highlight) return;
    const timer = window.setTimeout(() => setHighlight(null), 3000);
    return () => window.clearTimeout(timer);
  }, [highlight]);
  return { rootRef, highlightedColumn: highlight?.name };
}
