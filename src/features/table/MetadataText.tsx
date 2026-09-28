import { Fragment, useEffect, useState } from "react";
import { api } from "../../ipc";
import type { ColumnMeta, ForeignKeyMeta, TableMeta } from "../../ipc/types";
import type { TableTab } from "../../stores/useTabStore";
import { fieldTypeStyle } from "../grid/valueColor";

export function TypedColumns({ names, columns, suffixes = [] }: {
  names: string[]; columns?: ColumnMeta[]; suffixes?: string[];
}) {
  return <>{names.map((name, i) => {
    const column = columns?.find(c => c.name === name);
    return <Fragment key={i}>{i > 0 && ", "}<span
      className="dw-metadata-column"
      style={column ? fieldTypeStyle(column.rawType, column.canonical) : undefined}
      title={column ? `${name} · ${column.rawType}` : `${name} · 类型未获取`}
    >{name}{suffixes[i]}{column && <small className="dw-metadata-type">{column.rawType}</small>}</span></Fragment>;
  })}</>;
}

export function MetadataTag({ value, category }: { value: string; category: "index" | "method" | "rule" }) {
  const colors: Record<string, string> = category === "index"
    ? { "主键": "number", "唯一": "date", "普通": "text" }
    : category === "method"
      ? { BTREE: "number", HASH: "date", FULLTEXT: "text", GIN: "document", GIST: "boolean", SPGIST: "boolean", BRIN: "text", RTREE: "document" }
      : { CASCADE: "boolean", "SET NULL": "date", "SET DEFAULT": "document", RESTRICT: "text", "NO ACTION": "number" };
  const color = colors[value.toUpperCase()];
  return <span className="dw-metadata-tag" style={color ? { color: `var(--dw-value-${color})` } : undefined}>{value || "—"}</span>;
}

function referenceKey(tab: TableTab, fk: ForeignKeyMeta) {
  return JSON.stringify([fk.refDatabase ?? tab.database, fk.refSchema ?? tab.schema ?? null, fk.refTable]);
}

export function useReferenceColumns(tab: TableTab, detail: TableMeta) {
  const [loaded, setLoaded] = useState<{ scope: string; detail: TableMeta; tables: Record<string, TableMeta> }>();
  const scope = JSON.stringify([tab.sessionId, tab.database, tab.schema, tab.table]);
  useEffect(() => {
    let cancelled = false;
    const targets = new Map(detail.foreignKeys.map(fk => [referenceKey(tab, fk), fk]));
    const tables: Record<string, TableMeta> = {};
    const queue = [...targets.entries()];
    // 仅加载引用表元数据，去重并限制并发；无权限时保留名称，不猜测类型。
    const worker = async () => {
      while (!cancelled && queue.length) {
        const [key, fk] = queue.shift()!;
        const database = fk.refDatabase ?? tab.database;
        const schema = fk.refSchema ?? tab.schema;
        if (database === tab.database && (schema ?? null) === (tab.schema ?? null) && fk.refTable === tab.table) {
          tables[key] = detail;
        } else {
          try { tables[key] = await api.tableDetail(tab.sessionId, database, fk.refTable, schema); }
          catch { /* 引用目标可能不可访问，不影响外键列表显示。 */ }
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker)).then(() => {
      if (!cancelled) setLoaded({ scope, detail, tables });
    });
    return () => { cancelled = true; };
  }, [scope, detail, tab.sessionId, tab.database, tab.schema, tab.table]);
  return (fk: ForeignKeyMeta) => loaded?.scope === scope && loaded.detail === detail
    ? loaded.tables[referenceKey(tab, fk)]?.columns : undefined;
}
