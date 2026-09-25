import {valueCellStyle} from "./valueColor";
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgGridReact } from "ag-grid-react";
import { Button, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, MenuItem, MenuList, makeStyles, tokens } from "@fluentui/react-components";
import { CopyRegular, ZoomInRegular } from "@fluentui/react-icons";
import { ValueEditor } from "./ValueEditor";
import type { ColDef, GridApi } from "ag-grid-community";
import { api } from "../../ipc";
import { ContextMenuPortal, ContextMenuSurface } from "../../app/ContextMenuPortal";
import {
  formatDbValue,
  isNullValue,
  isReadOnlyValue,
  type ColumnInfo,
  type DbValue,
  type SortSpec,
} from "../../ipc/types";
import { useGridTheme } from "./register";
import { TypeHeader } from "./TypeHeader";

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
  columns: ColumnInfo[];
  rows: DbValue[][];
  onSortChange?: (sort: SortSpec[]) => void;
}

function cellText(value: DbValue | undefined): string {
  if (isNullValue(value)) return "";
  return String(value?.[1] ?? "").replace(/\t/g, " ").replace(/\r?\n/g, " ");
}

export const ResultGrid = forwardRef<ResultGridHandle, Props>(function ResultGrid(
  { columns, rows, onSortChange },
  ref,
) {
  const theme = useGridTheme();
  const styles = useStyles();
  const [detail,setDetail]=useState<{name:string;value:DbValue}|null>(null);
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
        // 初始弹性布局填满容器，后续列定义更新不覆盖用户手动设置的宽度。
        initialFlex: 1,
        initialWidth: 110,
        minWidth: 110,
        // 服务端排序时禁用前端排序（返回 0 保持数据原顺序）
        comparator: onSortChange ? () => 0 : undefined,
        valueGetter: (params) => params.data?.cells[index],
        valueFormatter: (params) => formatDbValue(params.value as DbValue),
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
      .map((row) => row.cells.map((cell) => cellText(cell)).join("\t"))
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
      filter: true,
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
        if(detail || (event.target as HTMLElement).closest("input,textarea,[contenteditable=true]"))return;
        if (!(event.ctrlKey || event.metaKey)) return;
        if (event.key.toLowerCase() !== "c") return;
        event.preventDefault();
        event.stopPropagation();
        void copyRows(selectedOrFocusedRows());
      }}
    >
      <AgGridReact<ResultRow>
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
          apiRef.current = params.api;
        }}
        animateRows={false}
      />
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
                if(value)setDetail({name:columns[cellMenu.colIndex]?.name ?? "单元格",value});
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
      <Dialog open={detail!==null} onOpenChange={(_,d)=>{if(!d.open)setDetail(null);}}><DialogSurface style={{width:"90vw",maxWidth:1000}}><DialogBody>
        <DialogTitle>单元格详情 · {detail?.name}</DialogTitle><DialogContent>
          {detail && <><p>{detail.value[0]==="null" ? "NULL" : detail.value[0]==="readonly" ? "扩展类型或解析提示，只读显示。" : isReadOnlyValue(detail.value) ? "查询结果为截断预览；请在表数据页按主键查看完整值。" : "查询结果只读"}</p>
          <ValueEditor text={String(detail.value[1]??"")} binary={detail.value[0]==="bytes"} readOnly /></>}
        </DialogContent><DialogActions><Button onClick={()=>setDetail(null)}>关闭</Button></DialogActions>
      </DialogBody></DialogSurface></Dialog>
    </div>
  );
});
