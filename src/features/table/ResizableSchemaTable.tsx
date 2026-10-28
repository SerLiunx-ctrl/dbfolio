import { Children, createContext, isValidElement, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent, type KeyboardEvent } from "react";
import { Table, TableHeaderCell, type TableProps, type TableHeaderCellProps } from "@fluentui/react-components";
import type { Engine } from "../../ipc/types";
import { api } from "../../ipc";
import "./resizable-schema-table.css";

type TableKind = "structure" | "indexes" | "foreignKeys";
type Widths = Record<string, number>;
// 仅按引擎和表格类别缓存少量界面偏好，切页时无需等待设置落盘。
const widthCache = new Map<string, Widths>();
const columns: Record<string, { key: string; width: number; min: number }> = {
  "#": { key: "ordinal", width: 36, min: 32 }, "名称": { key: "name", width: 220, min: 44 },
  "类型": { key: "type", width: 140, min: 44 }, "声明类型": { key: "type", width: 140, min: 44 },
  "长度/集合": { key: "arguments", width: 110, min: 44 }, "可空": { key: "nullable", width: 60, min: 44 },
  "无符号": { key: "unsigned", width: 76, min: 44 }, "默认值": { key: "default", width: 190, min: 44 },
  "自动增长": { key: "identity", width: 80, min: 44 }, "ON UPDATE": { key: "onUpdate", width: 150, min: 44 },
  "键": { key: "key", width: 76, min: 44 }, "主键": { key: "primary", width: 60, min: 44 },
  "注释": { key: "comment", width: 280, min: 44 }, "操作": { key: "actions", width: 80, min: 80 },
  "列": { key: "columns", width: 400, min: 44 }, "方法": { key: "method", width: 100, min: 44 },
  "引用": { key: "reference", width: 420, min: 44 }, "引用表": { key: "referenceTable", width: 220, min: 44 },
  "引用列": { key: "referenceColumns", width: 240, min: 44 },
  "删除规则": { key: "onDelete", width: 120, min: 44 }, "更新规则": { key: "updateRule", width: 120, min: 44 },
};
type HeaderProps = TableHeaderCellProps & { columnKey?: string };
function definition(props: HeaderProps, kind: TableKind) {
  const label = typeof props.children === "string" || typeof props.children === "number" ? String(props.children) : props["aria-label"] ?? "列";
  const base = columns[label] ?? { key: label, width: 160, min: 44 };
  const specified = typeof props.style?.width === "number" ? props.style.width : undefined;
  const width = specified ?? (kind === "indexes" && base.key === "name" ? 260 : kind === "indexes" && base.key === "type" ? 90 : kind === "indexes" && base.key === "columns" ? 520 : base.width);
  return { key: props.columnKey ?? base.key, label, width, min: base.min };
}
function headers(children: ReactNode, kind: TableKind): ReturnType<typeof definition>[] {
  const result: ReturnType<typeof definition>[] = [];
  Children.forEach(children, child => {
    if (!isValidElement<HeaderProps>(child)) return;
    if (child.type === ResizableHeaderCell) result.push(definition(child.props, kind));
    else if (child.props.children) result.push(...headers(child.props.children, kind));
  });
  return result;
}
const ResizeContext = createContext<{
  kind: TableKind; widths: Widths | null; flexKey: string;
  begin: (key: string, event: PointerEvent<HTMLSpanElement>) => void;
  move: (event: PointerEvent<HTMLSpanElement>) => void;
  end: (event: PointerEvent<HTMLSpanElement>, cancel?: boolean) => void;
  adjust: (key: string, change: number | "reset") => void;
} | null>(null);

export function ResizableSchemaTable({ kind, engine, children, className, style, ...props }: TableProps & { kind: TableKind; engine: Engine }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const scope = `dw.schemaWidths.v1.${engine}.${kind}`;
  const specs = useMemo(() => headers(children, kind), [children, kind]);
  const [layout, setLayout] = useState<{ scope: string; widths: Widths | null }>({ scope, widths: widthCache.get(scope) ?? null });
  const widths = layout.scope === scope ? layout.widths : null;
  const adjusted = useRef(false);
  const drag = useRef<{ key: string; x: number; scale: number; widths: Widths; latest: Widths; original: Widths | null; pointerId: number; changed: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    adjusted.current = false; drag.current = null; setLayout({ scope, widths: widthCache.get(scope) ?? null });
    if (widthCache.has(scope)) return;
    void api.settingsGet(scope).then(value => {
      if (!alive || adjusted.current) return;
      const cached = widthCache.get(scope);
      if (cached) { setLayout({ scope, widths: cached }); return; }
      if (!value) return;
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const saved = Object.fromEntries(Object.entries(parsed).filter(([key, width]) => Object.values(columns).some(c => c.key === key) && typeof width === "number" && Number.isFinite(width) && width >= 32 && width <= 16384));
      if (Object.keys(saved).length) { widthCache.set(scope, saved); setLayout({ scope, widths: saved }); }
    }).catch(() => {});
    return () => { alive = false; drag.current = null; };
  }, [scope]);
  const clamp = (key: string, width: number) => Math.round(Math.max(specs.find(c => c.key === key)?.min ?? 44, Math.min(16384, width)));
  const snapshot = () => {
    const table = tableRef.current;
    const scale = table ? table.getBoundingClientRect().width / (table.offsetWidth || 1) || 1 : 1;
    const current = { ...widths };
    table?.querySelectorAll<HTMLTableCellElement>("thead th[data-schema-column]").forEach(cell => { current[cell.dataset.schemaColumn!] = cell.getBoundingClientRect().width / scale; });
    return { widths: current, scale };
  };
  const apply = (next: Widths) => { adjusted.current = true; setLayout({ scope, widths: next }); };
  const save = (next: Widths) => { widthCache.set(scope, next); void api.settingsSet(scope, JSON.stringify(next)).catch(() => {}); };
  const begin = (key: string, event: PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); adjusted.current = true;
    const current = snapshot();
    drag.current = { key, x: event.clientX, scale: current.scale, widths: current.widths, latest: current.widths, original: widths, pointerId: event.pointerId, changed: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLSpanElement>) => {
    const start = drag.current; if (!start || start.pointerId !== event.pointerId) return;
    const width = clamp(start.key, start.widths[start.key] + (event.clientX - start.x) / start.scale);
    if (width === start.latest[start.key]) return;
    start.latest = { ...start.widths, [start.key]: width }; start.changed = true; apply(start.latest);
  };
  const end = (event: PointerEvent<HTMLSpanElement>, cancel = false) => {
    const start = drag.current; if (!start || start.pointerId !== event.pointerId) return;
    drag.current = null;
    if (cancel) setLayout({ scope, widths: start.original });
    else if (start.changed) save(start.latest);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const adjust = (key: string, change: number | "reset") => {
    const current = snapshot().widths;
    const next = { ...current, [key]: clamp(key, change === "reset" ? specs.find(c => c.key === key)?.width ?? 160 : current[key] + change) };
    apply(next); save(next);
  };
  const total = specs.reduce((sum, spec) => sum + (widths?.[spec.key] === undefined ? spec.width : clamp(spec.key, widths[spec.key])), 0);
  const flexKey = kind === "structure" ? "comment" : kind === "indexes" ? "columns" : specs.some(c => c.key === "reference") ? "reference" : "referenceColumns";
  return <ResizeContext.Provider value={{ kind, widths, flexKey, begin, move, end, adjust }}>
    <Table {...props} ref={tableRef} className={`dw-resizable-schema-table ${className ?? ""}`} style={{ ...style, tableLayout: "fixed", width: widths ? total : "100%", minWidth: total }}>{children}</Table>
  </ResizeContext.Provider>;
}

export function ResizableHeaderCell({ columnKey, children, className, style, ...props }: HeaderProps) {
  const resize = useContext(ResizeContext);
  if (!resize) return <TableHeaderCell {...props} className={className} style={style}>{children}</TableHeaderCell>;
  const spec = definition({ ...props, columnKey, children, style }, resize.kind);
  const width = Math.max(spec.min, resize.widths?.[spec.key] ?? spec.width);
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); resize.adjust(spec.key, event.key === "Home" ? "reset" : (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 50 : 10));
  };
  return <TableHeaderCell {...props} data-schema-column={spec.key} aria-label={props["aria-label"] ?? spec.label} title={props.title ?? spec.label} className={`dw-resizable-header ${className ?? ""}`} style={{ ...style, width: !resize.widths && resize.flexKey === spec.key ? undefined : width }}
    aside={<span className="dw-schema-resizer" role="separator" tabIndex={0} aria-label={`调整${spec.label}列宽`} aria-orientation="vertical" aria-valuenow={Math.round(width)} aria-valuemin={spec.min} aria-valuemax={16384}
      title="拖动调整列宽；双击恢复默认；左右方向键微调" onPointerDown={event => resize.begin(spec.key, event)} onPointerMove={resize.move}
      onPointerUp={event => resize.end(event)} onPointerCancel={event => resize.end(event, true)} onLostPointerCapture={event => resize.end(event)}
      onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); resize.adjust(spec.key, "reset"); }} onKeyDown={onKeyDown} onClick={event => event.stopPropagation()} />}
  ><span className="dw-schema-header-text">{children}</span></TableHeaderCell>;
}
