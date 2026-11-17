import { loadedFindRules } from './GridFind';
import {valueCellStyle} from "./valueColor";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgGridReact } from "ag-grid-react";
import { MenuDivider, MenuItem } from "@fluentui/react-components";
import { TextFieldRegular, CopyRegular, ZoomInRegular, CodeRegular } from "@fluentui/react-icons";
import { CellInspector, type InspectorTarget } from "./CellInspector";
import { GridWorkbench, GridColumns, GridIconButton, useGridLayout } from "./GridWorkbench";
import { ImageCell } from './ImageCell';
import { isImageCandidate } from './base64Image';
import { cellPreview } from './cellPreview';
import type { ColDef, GridApi } from "ag-grid-community";
import { GridContextMenu, GridMenuSubmenu } from "./GridContextMenu";
import {
  formatDbValue,
  isNullValue,
  type ColumnInfo,
  type DbValue,
  type SortSpec,
} from "../../ipc/types";
import { useGridTheme } from "./register";
import { TypeHeader } from "./TypeHeader";
import { initialColumnSizing } from "./columnSizing";
import { useNotify } from "../../app/toast";
import { writeRowClipboard, writeCellClipboard } from "./rowClipboard";
import { CopyRowsSqlDialog } from "./CopyRowsSqlDialog";

interface ResultRow {
  key: string;
  cells: DbValue[];
}

export interface ResultGridHandle {
  copySelected: () => Promise<number>;
}

interface Props {
  sessionId?: string;
  database?: string;
  schema?: string | null;
  toolbarHost?:HTMLElement|null;
  columns: ColumnInfo[];
  rows: DbValue[][];
  onSortChange?: (sort: SortSpec[]) => void;
}

function cellText(value: DbValue | undefined): string {
  if (isNullValue(value)) return "";
  return String(value?.[1] ?? "");
}

export const ResultGrid = forwardRef<ResultGridHandle, Props>(function ResultGrid(
  { columns, rows, onSortChange,toolbarHost,sessionId,database,schema },
  ref,
) {
  const theme = useGridTheme();
  const notify = useNotify();
  const [sqlCopy,setSqlCopy]=useState<{kind:"insert"|"update";columns:ColumnInfo[];rows:DbValue[][];sessionId:string;database:string;schema?:string|null}|null>(null);
  const [detail,setDetail]=useState<InspectorTarget|null>(null);
  const [inspectorOpen,setInspectorOpen]=useState(false);
  const layout=useGridLayout("query",columns);
  const inspect=(rowIndex:number,colIndex:number,force=false)=>{if(!inspectorOpen&&!force)return;const value=apiRef.current?.getDisplayedRowAtIndex(rowIndex)?.data?.cells[colIndex];if(!value)return;const c=columns[colIndex];if(!c)return;setDetail({id:rowIndex+":"+colIndex,name:c.name,rawType:c.rawType,value});if(force)setInspectorOpen(true);};
  const apiRef = useRef<GridApi<ResultRow> | null>(null);
  const focusedRef = useRef<{ rowIndex: number; colIndex: number }>({
    rowIndex: -1,
    colIndex: -1,
  });
  const [cellMenu, setCellMenu] = useState<{
    x: number;
    y: number;
    rowIndex: number;
    colIndex: number;
    targets: ResultRow[];
  } | null>(null);

  useEffect(()=>{setDetail(null);setCellMenu(null);},[rows,columns]);
  const rowData = useMemo<ResultRow[]>(
    () => rows.map((cells, index) => ({ key: `r${index}`, cells })),
    [rows],
  );

  const columnDefs = useMemo<ColDef<ResultRow>[]>(
    () =>
      columns.map((column, index) => ({
        colId: `c${index}`,
        headerName: column.name,
        headerTooltip: column.rawType,
        headerComponent: TypeHeader,
        headerComponentParams: { columnType: column.rawType },
        sortable: Boolean(onSortChange),
        ...initialColumnSizing(column, rows, index),
        // 服务端排序时禁用前端排序（返回 0 保持数据原顺序）
        comparator: onSortChange ? () => 0 : undefined,
        valueGetter: (params) => params.data?.cells[index],
        valueFormatter: (params) => cellPreview(formatDbValue(params.value as DbValue)),
        cellRendererSelector: (params) => {
          const value = params.value as DbValue | undefined;
          if (!isImageCandidate(value)) return undefined;
          return { component: ImageCell, params: { value, text: formatDbValue(value), onOpen: () => { if (value) {setDetail({id:index+":"+String(params.node.id),name:column.name,rawType:column.rawType,value});setInspectorOpen(true);} } } };
        },
        cellStyle: (params) => valueCellStyle(column.rawType, params.value as DbValue),
      })),
    [columns, onSortChange],
  );

  const selectedOrFocusedRows = useCallback((): ResultRow[] => {
    const gridApi = apiRef.current;
    if (!gridApi) return [];
    const selected = gridApi
      .getSelectedNodes()
      .sort((a,b)=>(a.rowIndex??0)-(b.rowIndex??0))
      .map((node) => node.data)
      .filter((row): row is ResultRow => Boolean(row));
    if (selected.length > 0) return selected;
    const { rowIndex } = focusedRef.current;
    if (rowIndex >= 0) {
      const row = gridApi.getDisplayedRowAtIndex(rowIndex)?.data;
      if (row) return [row];
    }
    return [];
  }, []);

  const visibleRows = useCallback((targets:ResultRow[])=>{
    const indexes=apiRef.current
      ?apiRef.current.getAllDisplayedColumns().map(c=>c.getColId()).filter(id=>/^c\d+$/.test(id)).map(id=>Number(id.slice(1)))
      :columns.map((_,index)=>index);
    return {columns:indexes.map(index=>columns[index]),rows:targets.map(row=>indexes.map(index=>row.cells[index]))};
  },[columns]);
  const copyRows = useCallback(async (targets: ResultRow[]) => {
    if (targets.length === 0) return 0;
    try {const selected=visibleRows(targets);return await writeRowClipboard(selected.columns,selected.rows);}
    catch(error){notify.error(error,"复制行失败");return 0;}
  }, [notify,visibleRows]);
  const sqlCopyUnavailable=!sessionId||!database?"查询结果缺少会话或数据库上下文，无法选择目标表":!cellMenu?.targets.length?"请先选择要复制的行":undefined;
  const openSqlCopy=(kind:"insert"|"update")=>{
    if(sqlCopyUnavailable||!cellMenu||!sessionId||!database)return;
    setSqlCopy({kind,...visibleRows(cellMenu.targets),sessionId,database,schema});setCellMenu(null);
  };

  useImperativeHandle(
    ref,
    () => ({ copySelected: async () => copyRows(selectedOrFocusedRows()) }),
    [copyRows, selectedOrFocusedRows],
  );

  const defaultColDef = useMemo(
    () => ({
      initialWidth: 110,
      minWidth: 110,
      resizable: true,
      sortable: Boolean(onSortChange),
      filter: true,cellClassRules:loadedFindRules,
    }),
    [onSortChange],
  );

  const rowSelection = useMemo(
    () => ({ mode: "multiRow" as const, enableClickSelection: true }),
    [],
  );

  return (
    <div
      style={{ width: "100%", height: "100%" }}
      onContextMenu={event=>{
        const target=event.target as HTMLElement;
        if(!target.closest('.ag-root-wrapper')||target.closest('.ag-cell,.ag-header'))return;
        event.preventDefault();
        setCellMenu({x:event.clientX,y:event.clientY,rowIndex:-1,colIndex:-1,targets:selectedOrFocusedRows()});
      }}
      onKeyDownCapture={(event) => {
        if((event.target as HTMLElement).closest("input,textarea,[contenteditable=true],.dw-grid-inspector"))return;
        if (!(event.ctrlKey || event.metaKey)) return;
        if (event.key.toLowerCase() !== "c") return;
        event.preventDefault();
        event.stopPropagation();
        void copyRows(selectedOrFocusedRows());
      }}
    >
      <GridWorkbench toolbarHost={toolbarHost} grid={layout.grid} tools={<><GridColumns layout={layout} columns={columns}/><GridIconButton showLabel label="单元格详情" icon={<TextFieldRegular/>} aria-pressed={inspectorOpen} appearance={inspectorOpen?"primary":"secondary"} onClick={()=>{if(inspectorOpen){setInspectorOpen(false);setDetail(null);}else{setInspectorOpen(true);inspect(focusedRef.current.rowIndex,focusedRef.current.colIndex,true);}}}/></>} inspector={inspectorOpen?<CellInspector target={detail}/>:null} onClose={()=>{setInspectorOpen(false);setDetail(null);}}><AgGridReact<ResultRow>
        theme={theme}
        rowData={rowData}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        headerHeight={38}
        getRowId={(params) => params.data.key}
        rowSelection={rowSelection}
        onCellFocused={(event) => {
          const colId =
            event.column && typeof event.column === "object"
              ? event.column.getColId()
              : "";
          const colIndex = colId ? Number(String(colId).replace("c", "")) : -1;
          focusedRef.current = {
            rowIndex: event.rowIndex ?? -1,
            colIndex: Number.isFinite(colIndex) ? colIndex : -1,
          };
        }}
        onCellClicked={event=>inspect(event.rowIndex??-1,Number(event.column.getColId().replace("c","")))}
        onCellKeyDown={event=>{const key=(event.event as KeyboardEvent)?.key;if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Tab"].includes(key))setTimeout(()=>inspect(focusedRef.current.rowIndex,focusedRef.current.colIndex),0);}}
        onCellContextMenu={(event) => {
          const mouse = event.event as MouseEvent | null | undefined;
          mouse?.preventDefault();
          const colId =
            event.column && typeof event.column === "object"
              ? event.column.getColId()
              : "";
          const colIndex = colId ? Number(String(colId).replace("c", "")) : -1;
          if(event.node.data&&!event.node.isSelected()){
            event.api.deselectAll();event.node.setSelected(true);
          }
          focusedRef.current={rowIndex:event.rowIndex??-1,colIndex:Number.isFinite(colIndex)?colIndex:-1};
          setCellMenu({
            x: mouse?.clientX ?? 0,
            y: mouse?.clientY ?? 0,
            rowIndex: event.rowIndex ?? -1,
            colIndex: Number.isFinite(colIndex) ? colIndex : -1,
            targets:selectedOrFocusedRows(),
          });
        }}
        onSortChanged={(params) => {
          if (!onSortChange) return;
          const state = params.api
            .getColumnState()
            .filter((item) => item.sort)
            .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
          const specs: SortSpec[] = state
            .map((item) => {
              const index = Number(String(item.colId).replace("c", ""));
              const column = columns[index];
              if (!column) return null;
              return { column: column.name, dir: item.sort as "asc" | "desc" };
            })
            .filter((item): item is SortSpec => item !== null);
          onSortChange(specs);
          params.api.refreshHeader();
        }}
        onGridReady={(params) => {
          apiRef.current = params.api;layout.setGrid(params.api);
        }}
        onColumnResized={e=>{if(e.finished&&e.source!=="gridInitializing")layout.persist();}}
        onColumnMoved={e=>{if(e.finished)layout.persist();}}
        onColumnPinned={()=>layout.persist()}
        onColumnVisible={()=>layout.persist()}
        animateRows={false}
      /></GridWorkbench>
      {cellMenu && (
        <GridContextMenu x={cellMenu.x} y={cellMenu.y} onClose={() => setCellMenu(null)}>
          <MenuItem icon={<ZoomInRegular />} disabled={cellMenu.rowIndex<0||cellMenu.colIndex<0} onClick={()=>{
            const value=apiRef.current?.getDisplayedRowAtIndex(cellMenu.rowIndex)?.data?.cells[cellMenu.colIndex];
            if(value)inspect(cellMenu.rowIndex,cellMenu.colIndex,true);
            setCellMenu(null);
          }}>查看单元格详情</MenuItem>
          <MenuDivider/>
          <GridMenuSubmenu label="复制" icon={<CopyRegular/>}>
            <MenuItem
              icon={<CopyRegular />}
              disabled={cellMenu.rowIndex<0||cellMenu.colIndex<0}
              onClick={() => {
                const gridApi = apiRef.current;
                const row = gridApi
                  ?.getDisplayedRowAtIndex(cellMenu.rowIndex)
                  ?.data;
                void writeCellClipboard(cellText(row?.cells[cellMenu.colIndex])).catch(error=>notify.error(error,"复制单元格失败"));
                setCellMenu(null);
              }}
            >
              复制单元格
            </MenuItem>
            <MenuItem
              icon={<CopyRegular />}
              disabled={!cellMenu.targets.length}
              onClick={() => {
                void copyRows(cellMenu.targets);
                setCellMenu(null);
              }}
            >
              复制行
            </MenuItem>
          </GridMenuSubmenu>
          <GridMenuSubmenu label="复制 SQL" icon={<CodeRegular/>}>
            <MenuItem icon={<CodeRegular/>} disabled={!!sqlCopyUnavailable} title={sqlCopyUnavailable} onClick={()=>openSqlCopy("insert")}>复制为 INSERT 语句…</MenuItem>
            <MenuItem icon={<CodeRegular/>} disabled={!!sqlCopyUnavailable} title={sqlCopyUnavailable} onClick={()=>openSqlCopy("update")}>复制为 UPDATE 语句…</MenuItem>
          </GridMenuSubmenu>
        </GridContextMenu>
      )}
      {sqlCopy&&<CopyRowsSqlDialog {...sqlCopy} onClose={()=>setSqlCopy(null)}/>}

    </div>
  );
});
