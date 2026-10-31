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
import { MenuItem, MenuList, makeStyles, tokens } from "@fluentui/react-components";
import { TextFieldRegular, CopyRegular, ZoomInRegular } from "@fluentui/react-icons";
import { CellInspector, type InspectorTarget } from "./CellInspector";
import { GridWorkbench, GridColumns, GridIconButton, useGridLayout } from "./GridWorkbench";
import { ImageCell } from './ImageCell';
import { isImageCandidate } from './base64Image';
import { cellPreview } from './cellPreview';
import type { ColDef, GridApi } from "ag-grid-community";
import { api } from "../../ipc";
import { ContextMenuPortal, ContextMenuSurface } from "../../app/ContextMenuPortal";
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

const useStyles = makeStyles({
  menuOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 1198,
  },
  menu: {
    position: "fixed",
    zIndex: 1199,
    minWidth: "160px",
    padding: "4px",
    borderRadius: "6px",
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow16,
  },
});

interface ResultRow {
  key: string;
  cells: DbValue[];
}

export interface ResultGridHandle {
  copySelected: () => Promise<number>;
}

interface Props {
  toolbarHost?:HTMLElement|null;
  columns: ColumnInfo[];
  rows: DbValue[][];
  onSortChange?: (sort: SortSpec[]) => void;
}

function cellText(value: DbValue | undefined): string {
  if (isNullValue(value)) return "";
  return String(value?.[1] ?? "").replace(/\t/g, " ").replace(/\r?\n/g, " ");
}

export const ResultGrid = forwardRef<ResultGridHandle, Props>(function ResultGrid(
  { columns, rows, onSortChange,toolbarHost },
  ref,
) {
  const theme = useGridTheme();
  const styles = useStyles();
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
  } | null>(null);

  useEffect(()=>{setDetail(null);},[rows,columns]);
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

  const copyRows = useCallback(async (targets: ResultRow[]) => {
    if (targets.length === 0) return 0;
    const text = targets
      .map((row) => (apiRef.current?.getAllDisplayedColumns().filter(c=>/^c\d+$/.test(c.getColId())).map(c=>row.cells[Number(c.getColId().slice(1))])??row.cells).map((cell) => cellText(cell)).join("\t"))
      .join("\n");
    await api.clipboardWriteText(text);
    return targets.length;
  }, []);

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
          setCellMenu({
            x: mouse?.clientX ?? 0,
            y: mouse?.clientY ?? 0,
            rowIndex: event.rowIndex ?? -1,
            colIndex: Number.isFinite(colIndex) ? colIndex : -1,
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
        <ContextMenuPortal>
          <div
            className={styles.menuOverlay}
            onClick={() => setCellMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setCellMenu(null);
            }}
          />
          <ContextMenuSurface className={`${styles.menu} dw-context-menu`} x={cellMenu.x} y={cellMenu.y}>
            <MenuList>
              <MenuItem icon={<ZoomInRegular />} onClick={()=>{
                const value=apiRef.current?.getDisplayedRowAtIndex(cellMenu.rowIndex)?.data?.cells[cellMenu.colIndex];
                if(value)inspect(cellMenu.rowIndex,cellMenu.colIndex,true);
                setCellMenu(null);
              }}>查看单元格详情</MenuItem>
              <MenuItem
                icon={<CopyRegular />}
                onClick={() => {
                  const gridApi = apiRef.current;
                  const row = gridApi
                    ?.getDisplayedRowAtIndex(cellMenu.rowIndex)
                    ?.data;
                  void api.clipboardWriteText(cellText(row?.cells[cellMenu.colIndex]));
                  setCellMenu(null);
                }}
              >
                复制单元格
              </MenuItem>
              <MenuItem
                icon={<CopyRegular />}
                onClick={() => {
                  void copyRows(selectedOrFocusedRows());
                  setCellMenu(null);
                }}
              >
                复制选中行
              </MenuItem>
            </MenuList>
          </ContextMenuSurface>
        </ContextMenuPortal>
      )}

    </div>
  );
});
