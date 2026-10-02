import {useSettingsStore} from "../../stores/useSettingsStore";
import {useSessionStore} from "../../stores/useSessionStore";
import {ResultCompareActions} from "../compare/ResultCompare";
import {RelatedRecords,type RelatedSelection} from "../relations/RelatedRecords";
import { confirmEdits, usePendingEdit } from "../../stores/useEditGuard";
import { integerCursor, keysetSql } from "./keyset";
import {
  Badge,
  Button,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Spinner,
  Tag,
  Tooltip,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  AddRegular,
  ArrowClockwiseRegular,
  ArrowDownloadRegular,
  ArrowLeftRegular,
  ArrowRightRegular,
  ArrowUploadRegular,
  CheckmarkRegular,
  ClipboardPasteRegular,
  CopyRegular,
  DeleteRegular,
  DismissRegular,
  FilterRegular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";
import type {
  DbValue,
  Engine,
  FilterCondition,
  RowChange,
  SortSpec,
  TableMeta,
} from "../../ipc/types";
import { isReadOnlyValue } from "../../ipc/types";
import type { TableTab } from "../../stores/useTabStore";
import {
  EditableDataGrid,
  type EditableDataGridHandle,
} from "../grid/EditableDataGrid";
import { buildTableSelect } from "../grid/value";
import { ExportDialog } from "../transfer/ExportDialog";
import { ImportDialog } from "../transfer/ImportDialog";
import { DataChangePreview } from "./DataChangePreview";
import { FilterPanel } from "./FilterPanel";



const useStyles = makeStyles({
  root: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 10px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    flexShrink: 0,
  },
  grid: {
    flex: 1,
    minHeight: 0,
  },
  status: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "4px 10px",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    flexShrink: 0,
  },
  spacer: { flex: 1 },
  centered: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
});

interface Props {
  tab: TableTab;
  active: boolean;
  detail: TableMeta;
  engine: Engine;
  readOnly: boolean;
  onChanged: () => void;
}

export function TableDataPanel({ tab, active, detail, engine, readOnly, onChanged }: Props) {
  const styles = useStyles();
  const pageSizeRef = useRef(useSettingsStore.getState().queryPageSize);
  const [pageSize, setPageSize] = useState(pageSizeRef.current);
  const sourceName=useSessionStore(s=>s.sessions.find(v=>v.id===tab.sessionId)?.name)??tab.sessionId;
  const [related,setRelated]=useState<RelatedSelection|null>(null);
  const relationSource=useMemo(()=>({sessionId:tab.sessionId,database:tab.database,schema:tab.schema,table:tab.table}),[tab.sessionId,tab.database,tab.schema,tab.table]);
  const notify = useNotify();
  const gridRef = useRef<EditableDataGridHandle | null>(null);
  const requestIdRef = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const changesRef = useRef(0);
  const [stale, setStale] = useState(false);
  const [gridSuspended, setGridSuspended] = useState(false);
  const [rows, setRows] = useState<DbValue[][]>([]);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [changes, setChanges] = useState<RowChange[]>([]);
  changesRef.current = changes.length;
  const [selected, setSelected] = useState(0);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [sort, setSort] = useState<SortSpec[]>([]);
  const [filters, setFilters] = useState<FilterCondition[]>([]);
  const [conjunction, setConjunction] = useState<"and" | "or">("and");
  const [whereClause, setWhereClause] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const pageCursors = useRef(new Map<number, string>());
  const primaryColumn = detail.primaryKey.length === 1 ? detail.columns.find(column => column.name === detail.primaryKey[0]) : undefined;
  const seekKey = primaryColumn && /^(tinyint|smallint|mediumint|int|integer|bigint|int2|int4|int8|serial|bigserial)\b/i.test(primaryColumn.rawType) && !primaryColumn.nullable && sort.length === 0 && !whereClause.trim() ? primaryColumn.name : null;

  const sql = useMemo(
    () =>
      `${buildTableSelect(
        engine,
        tab.database,
        tab.schema,
        tab.table,
        detail.columns,
      )}${whereClause}`,
    [detail.columns, engine, tab.database, tab.schema, tab.table, whereClause],
  );

  const hasTruncated = useMemo(
    () => rows.some((row) => row.some((cell) => isReadOnlyValue(cell))),
    [rows],
  );

  const load = useCallback(
    async (nextOffset = 0, refreshSize = nextOffset === 0) => {
      const limit = refreshSize ? useSettingsStore.getState().queryPageSize : pageSizeRef.current;
      const requestId = ++requestIdRef.current;
      setLoading(true);
      try {
        const started = performance.now();
        if (nextOffset === 0) pageCursors.current.clear();
        const cursor = pageCursors.current.get(nextOffset);
        const useSeek = seekKey !== null && (nextOffset === 0 || cursor !== undefined);
        const pageSql = seekKey ? keysetSql(sql, engine, seekKey, useSeek ? cursor ?? null : null) : sql;
        const data =
          nextOffset === 0
            ? await api.queryExecute(tab.sessionId, tab.database, pageSql, {
                limit,
                sort,
              })
            : await api.queryFetchPage(
                tab.sessionId,
                tab.database,
                pageSql,
                useSeek ? 0 : nextOffset,
                limit,
                sort,
              );
        if (requestId !== requestIdRef.current) return;
        pageSizeRef.current = limit; setPageSize(limit);
        for (const page of pageCursors.current.keys()) if (page > nextOffset) pageCursors.current.delete(page);
        if (seekKey && data.rows.length > 0) {
          const columnIndex = detail.columns.findIndex(column => column.name === seekKey);
          const nextCursor = integerCursor(data.rows[data.rows.length - 1][columnIndex]);
          if (nextCursor !== null) pageCursors.current.set(nextOffset + limit, nextCursor);
        }
        setRows(data.rows);
        setOffset(nextOffset);
        setElapsed(Math.round(performance.now() - started));
      } catch (error) {
        if (requestId === requestIdRef.current) {
          notify.error(error, "加载数据失败");
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [notify, sort, sql, tab.database, tab.sessionId, seekKey, engine, detail.columns],
  );

  useEffect(() => {
    setChanges([]);
    if (active) void load(0);
    else setStale(true);
  // 查询条件改变时仍按原逻辑重新加载；后台页签待激活再加载。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  useEffect(() => {
    if (active) {
      setGridSuspended(false);
      if (stale) { setStale(false); void load(offset); }
      return;
    }
    // 先结束正在输入的单元格，让 AG Grid 将值写入待提交变更。
    gridRef.current?.finishEditing();
    const suspendTimer = window.setTimeout(() => {
      if (!activeRef.current && changesRef.current === 0) {
        setGridSuspended(true);
        setSelected(0);
      }
    }, 300);
    // 保留短时间切换的结果；长期闲置且没有待提交编辑时释放行数据。
    const timer = window.setTimeout(() => {
      if (activeRef.current || changesRef.current > 0) return;
      ++requestIdRef.current;
      setLoading(false);
      setRows([]);
      setSelected(0);
      setStale(true);
    }, 30_000);
    return () => { window.clearTimeout(suspendTimer); window.clearTimeout(timer); };
  // 重新激活只在数据被回收后读取；普通切换不重复查询。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, changes.length, stale]);

  const canEdit =
    !readOnly && detail.kind === "table" && detail.primaryKey.length > 0;
  const hasPrev = offset > 0;
  const hasNext = rows.length === pageSize;

  const [partialSaved,setPartialSaved]=useState(false);
  const discardChanges=()=>{gridRef.current?.discard();setChanges([]);if(partialSaved){setPartialSaved(false);void load(offset);}};
  const commit = async (indexes?:number[]) => {
    const selected=indexes??changes.map((_,i)=>i);
    const submitted=selected.map(i=>changes[i]);
    const affected = await api.gridCommit(
      tab.sessionId,
      tab.database,
      tab.schema ?? null,
      tab.table,
      submitted,
    );
    if (affected === 0) throw new Error("数据库未修改任何行，请刷新数据并检查目标行是否仍存在");
    notify.success("修改已提交", `${affected} 行已更新`);
    if(submitted.length<changes.length){
      gridRef.current?.acceptChanges(selected);
      setChanges(changes.filter((_,i)=>!selected.includes(i)));
      setPartialSaved(true);
      return;
    }
    setPartialSaved(false);
    gridRef.current?.acceptChanges(selected);
    setChanges([]);
    onChanged();
    await load(offset);
  };

  usePendingEdit({ tabId: tab.id, sessionId: tab.sessionId, label: tab.database + "." + tab.table + "（表数据）",
    save: () => commit(), discard: discardChanges,
    preview: () => api.gridPreviewChanges(tab.sessionId, tab.database, tab.schema ?? null, tab.table, changes),
  }, changes.length > 0);
  const copySelected = async () => {
    try {
      const count = await gridRef.current?.copySelected();
      if (count) notify.success("已复制", `${count} 行（Tab 分隔，可直接粘贴到 Excel）`);
    } catch (error) {
      notify.error(error, "复制失败");
    }
  };

  const pasteClipboard = async () => {
    try {
      const count = await gridRef.current?.pasteFromClipboard();
      if (count) {
        notify.success("已粘贴", `${count} 个单元格（待提交）`);
      } else {
        notify.error(
          new Error("请先点击目标单元格，且该位置需可编辑（非主键/非只读字段）"),
          "无法粘贴",
        );
      }
    } catch (error) {
      notify.error(error, "粘贴失败");
    }
  };

  const applyFilters = async (
    nextFilters: FilterCondition[],
    nextConjunction: "and" | "or",
  ) => {
    if (changes.length > 0) {
      notify.error(new Error("请先提交或放弃当前单元格修改，再应用筛选"), "无法筛选");
      return;
    }
    try {
      const clause = await api.buildFilterClause(
        tab.sessionId,
        nextFilters,
        nextConjunction,
      );
      setFilters(nextFilters);
      setConjunction(nextConjunction);
      setWhereClause(clause);
      setFilterOpen(false);
    } catch (error) {
      notify.error(error, "生成筛选条件失败");
    }
  };

  const clearFilters = () => {
    if (changes.length > 0) {
      notify.error(new Error("请先提交或放弃当前单元格修改，再清空筛选"), "无法清空");
      return;
    }
    setFilters([]);
    setWhereClause("");
    setFilterOpen(false);
  };

  return (
    <div className={styles.root}>
      <div className={`${styles.toolbar} dw-data-toolbar`}>
        <Button
          size="small"
          icon={<ArrowClockwiseRegular />}
          onClick={async () => { if (await confirmEdits(e => e.tabId === tab.id)) await load(pageSizeRef.current === useSettingsStore.getState().queryPageSize ? offset : 0); }}
        >
          刷新
        </Button>
        <Button
          size="small"
          icon={<AddRegular />}
          disabled={!canEdit}
          onClick={() => gridRef.current?.addRow()}
        >
          添加行
        </Button>
        <Tooltip
          content={
            canEdit
              ? "标记删除选中行；点击提交后才会写入数据库，提交前可撤销"
              : readOnly
                ? "只读会话不可编辑"
                : detail.kind === "view"
                  ? "视图不可编辑"
                  : "无主键表不可编辑"
          }
          relationship="label"
        >
          <Button
            size="small"
            icon={<DeleteRegular />}
            disabled={!canEdit || selected === 0}
            onClick={() => gridRef.current?.deleteSelected()}
          >
            删除行
          </Button>
        </Tooltip>
        <Button size="small" icon={<CopyRegular />} onClick={() => void copySelected()}>
          复制
        </Button>
        <Tooltip
          content="从剪贴板粘贴（从当前单元格开始，可直接粘贴 Excel 内容）"
          relationship="label"
        >
          <Button
            size="small"
            icon={<ClipboardPasteRegular />}
            disabled={!canEdit}
            onClick={() => void pasteClipboard()}
          >
            粘贴
          </Button>
        </Tooltip>
        <Popover
          open={filterOpen}
          onOpenChange={(_, data) => setFilterOpen(data.open)}
          trapFocus
          positioning={{ position: "below", align: "start" }}
        >
          <PopoverTrigger disableButtonEnhancement>
            <Button
              size="small"
              icon={<FilterRegular />}
              appearance={filters.length > 0 ? "primary" : "secondary"}
            >
              筛选
              {filters.length > 0 ? ` ${filters.length}` : ""}
            </Button>
          </PopoverTrigger>
          <PopoverSurface style={{ maxWidth: "92vw", padding: "14px" }}>
            <FilterPanel
              scope={JSON.stringify([tab.sessionId,tab.database,tab.schema??null,tab.table])}
              columns={detail.columns}
              loadedRows={rows}
              initialFilters={filters}
              initialConjunction={conjunction}
              onApply={(nextFilters, nextConjunction) =>
                void applyFilters(nextFilters, nextConjunction)
              }
              onClear={clearFilters}
            />
          </PopoverSurface>
        </Popover>
        {filters.length > 0 && (
          <Button
            size="small"
            appearance="subtle"
            icon={<DismissRegular />}
            onClick={clearFilters}
          >
            清除筛选
          </Button>
        )}
        {!readOnly && detail.kind === "table" && (
          <Tooltip content="从 CSV 批量导入数据" relationship="label">
            <Button
              size="small"
              icon={<ArrowUploadRegular />}
              onClick={() => setImportOpen(true)}
            >
              导入
            </Button>
          </Tooltip>
        )}
        <Tooltip content="导出为 CSV / JSON / Excel（可导出全部数据）" relationship="label">
          <Button
            size="small"
            icon={<ArrowDownloadRegular />}
            disabled={rows.length === 0}
            onClick={() => setExportOpen(true)}
          >
            导出
          </Button>
        </Tooltip>
        <div className={styles.spacer} />
        {readOnly && <Tag size="small">只读</Tag>}
        {hasTruncated && (
          <Badge appearance="tint" color="warning" size="small">
            包含截断或扩展类型字段（相应单元格只读）
          </Badge>
        )}
        {detail.kind === "table" && detail.primaryKey.length === 0 && (
          <Badge appearance="tint" color="warning" size="small">
            无主键 · 只读
          </Badge>
        )}
        {partialSaved&&<span style={{fontSize:12}}>部分已提交；服务器生成值将在剩余修改处理后刷新</span>}
        {changes.length > 0 && (
          <Tag size="small" appearance="brand">
            {changes.length} 项待提交
          </Tag>
        )}
        <Button
          size="small"
          icon={<DismissRegular />}
          disabled={changes.length === 0}
          onClick={discardChanges}
        >
          放弃修改
        </Button>
        <Button
          appearance="primary"
          size="small"
          icon={<CheckmarkRegular />}
          disabled={changes.length === 0}
          onClick={() => setPreviewOpen(true)}
        >
          提交
        </Button>
      </div>

      <div style={{display:"flex",flex:1,minHeight:0,minWidth:0}}>
      <div className={`${styles.grid} dw-data-surface`} style={{minWidth:0}}>
        {loading && rows.length === 0 ? (
          <div className={styles.centered}>
            <Spinner label="加载数据…" />
          </div>
        ) : (active || changes.length > 0 || !gridSuspended) ? (
          <EditableDataGrid
            tabId={tab.id}
            ref={gridRef}
            columns={detail.columns}
            rows={rows}
            pkColumns={detail.primaryKey}
            sessionId={tab.sessionId}
            database={tab.database}
            schema={tab.schema}
            table={tab.table}
            readOnly={!canEdit}
            canSort={changes.length === 0}
            onRelated={(column,row)=>setRelated({column,row})}
            onFilterValue={(column,value)=>void applyFilters([{column,operator:value[0]==="null"?"isNull":"eq",value:value[0]==="null"?"":String(value[1]),literal:value}],"and")}
            onSortChange={setSort}
            onPendingChange={setChanges}
            onSelectionChange={setSelected}
            onSaved={() => void load(offset)}
          />
        ) : null}
      </div>

      {related&&<RelatedRecords key={related.column+JSON.stringify(related.row)} source={relationSource} meta={detail} engine={engine} selection={related} onClose={()=>setRelated(null)}/>}
      </div>
      <div className={`${styles.status} dw-data-footer`}>
        <span>
          第 {offset + 1} - {offset + rows.length} 行
        </span>
        {elapsed !== null && <span title="从页面发起请求到收到结果，包含通信、后端处理和历史记录保存，不含最终页面绘制">请求总耗时 {elapsed} ms</span>}
        <ResultCompareActions result={{columns:detail.columns.map(c=>({name:c.name,rawType:c.rawType})),rows,affected:null}} source={sourceName+" / "+tab.database+"."+(tab.schema?tab.schema+".":"")+tab.table} scope={`已加载第 ${offset+1}–${offset+rows.length} 行`} disabled={loading||changes.length>0}/>
        {seekKey && <span title="单整数主键、默认顺序且无筛选时，下一页从主键游标继续；不支持的情况回退普通分页">主键分页</span>}
        {loading && <Spinner size="tiny" label="加载中…" />}
        <div className={styles.spacer} />
        <Button
          appearance="subtle"
          size="small"
          icon={<ArrowLeftRegular />}
          disabled={!hasPrev || loading}
          onClick={async () => { if (await confirmEdits(e => e.tabId === tab.id)) await load(Math.max(0, offset - pageSize), false); }}
        >
          上一页
        </Button>
        <Button
          appearance="subtle"
          size="small"
          icon={<ArrowRightRegular />}
          disabled={!hasNext || loading}
          onClick={async () => { if (await confirmEdits(e => e.tabId === tab.id)) await load(offset + pageSize); }}
        >
          下一页
        </Button>
      </div>

      <DataChangePreview open={previewOpen} sessionId={tab.sessionId} database={tab.database} schema={tab.schema} table={tab.table} changes={changes} onApply={commit} onClose={()=>setPreviewOpen(false)}/>

      <ExportDialog
        open={exportOpen}
        sessionId={tab.sessionId}
        database={tab.database}
        sql={sql}
        sort={sort}
        pageSize={pageSize}
        pageOffset={offset}
        defaultName={`${tab.table}_${new Date().toISOString().slice(0, 10)}`}
        onClose={() => setExportOpen(false)}
      />

      <ImportDialog
        open={importOpen}
        sessionId={tab.sessionId}
        database={tab.database}
        schema={tab.schema}
        table={tab.table}
        columns={detail.columns}
        onClose={() => setImportOpen(false)}
        onDone={() => {
          void load(0);
          onChanged();
        }}
      />
    </div>
  );
}
