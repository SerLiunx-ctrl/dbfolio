import { loadedFindRules, refreshLoadedFind } from './GridFind';
import {valueCellStyle} from "./valueColor";
import { TextFieldRegular, FilterRegular } from "@fluentui/react-icons";
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
import {
  ClipboardPasteRegular,
  CopyRegular,
  EraserRegular,
  ZoomInRegular,
} from "@fluentui/react-icons";
import type { ColDef, GridApi, RowClassRules, ValueSetterParams } from "ag-grid-community";
import { api } from "../../ipc";
import { ContextMenuPortal, ContextMenuSurface } from "../../app/ContextMenuPortal";
import type { CellValue, ColumnMeta, DbValue, RowChange, SortSpec } from "../../ipc/types";
import { CellInspector, type InspectorTarget } from "./CellInspector";
import { GridWorkbench, GridColumns, GridIconButton, useGridLayout } from "./GridWorkbench";
import { ImageCell } from './ImageCell';
import { isImageCandidate } from './base64Image';
import { cellPreview } from './cellPreview';
import { ImageValueDialog, type ImageValueTarget } from './ImageValueDialog';
import { isNullValue, isReadOnlyValue } from "../../ipc/types";
import { parseCell } from "./value";
import { useGridTheme } from "./register";
import { TypeHeader } from "./TypeHeader";
import { initialColumnSizing } from "./columnSizing";
import { useNotify } from "../../app/toast";

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

type RowStateKind = "clean" | "dirty" | "new" | "deleted" | "saved";

interface CellState {
  value: DbValue;
  text: string;
}

interface GridRow {
  id: string;
  originalIndex: number | null;
  state: RowStateKind;
  cells: CellState[];
}

function toCell(value: DbValue): CellState {
  if (isNullValue(value)) return { value: ["null", null], text: "" };
  return { value, text: String(value[1] ?? "") };
}

function toRow(cells: DbValue[], originalIndex: number): GridRow {
  return {
    id: `row-${originalIndex}`,
    originalIndex,
    state: "clean",
    cells: cells.map(toCell),
  };
}

function sameValue(a: DbValue, b: DbValue): boolean {
  return a[0] === b[0] && JSON.stringify(a[1]) === JSON.stringify(b[1]);
}

export interface EditableDataGridHandle {
  finishEditing: () => void;
  addRow: () => void;
  deleteSelected: () => void;
  discard: () => void;
  getChanges: () => RowChange[];
  acceptChanges: (indexes: number[]) => void;
  copySelected: () => Promise<number>;
  pasteFromClipboard: () => Promise<number>;
}

interface Props {
  toolbarHost?:HTMLElement|null;
  onRelated?: (column: string, row: DbValue[]) => void;
  onFilterValue?: (column:string,value:DbValue)=>void;
  tabId: string;
  columns: ColumnMeta[];
  rows: DbValue[][];
  pkColumns: string[];
  sessionId: string;
  database: string;
  schema?: string | null;
  table: string;
  readOnly?: boolean;
  canSort?: boolean;
  onSortChange?: (sort: SortSpec[]) => void;
  onPendingChange?: (changes: RowChange[]) => void;
  onSelectionChange?: (count: number) => void;
  onSaved?: () => void;
  onValidationChange?: (error: string | null) => void;
}

export const EditableDataGrid = forwardRef<EditableDataGridHandle, Props>(
  function EditableDataGrid(
    {
      toolbarHost,
      columns,
      rows,
      pkColumns,
      sessionId,
      database,
      schema,
      table,
      readOnly = false,
      canSort = true,
      onRelated,
      onFilterValue,
      onSortChange,
      onPendingChange,
      onSelectionChange,
      onValidationChange,
    },
    ref,
  ) {
    const theme = useGridTheme();
    const notify = useNotify();
    const styles = useStyles();
    const apiRef = useRef<GridApi<GridRow> | null>(null);
    const newRowFocus = useRef<string | null>(null);
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
    const [inspectorOpen,setInspectorOpen]=useState(false);
    const [inspector,setInspector]=useState<InspectorTarget|null>(null);
    const invalidRef=useRef<string|null>(null);
    const layout=useGridLayout(JSON.stringify([sessionId,database,schema??null,table]),columns);
    const invalidCallback=useRef(onValidationChange);invalidCallback.current=onValidationChange;
    const setInvalid=(error:string|null)=>{invalidRef.current=error;invalidCallback.current?.(error);};

    const rowKeys = useCallback(
      (rowIndex: number): CellValue[] | null => {
        const gridApi = apiRef.current;
        if (!gridApi) return null;
        const row = gridApi.getDisplayedRowAtIndex(rowIndex)?.data;
        if (!row || row.originalIndex === null) return null;
        const keys: CellValue[] = [];
        for (const pk of pkColumns) {
          const index = columns.findIndex((column) => column.name === pk);
          if (index < 0) return null;
          const value = row.cells[index]?.value;
          if (!value || value[0] === "null" || isReadOnlyValue(value)) return null;
          keys.push({ column: pk, value });
        }
        return keys.length > 0 ? keys : null;
      },
      [columns, pkColumns],
    );
    const [data, setData] = useState<GridRow[]>([]);
    const [imageTarget,setImageTarget]=useState<ImageValueTarget|null>(null);
    const rowsRef = useRef(rows);


    useEffect(() => {
      setInspector(null);setInvalid(null);
      rowsRef.current = rows;
      setData(rows.map((cells, index) => toRow(cells, index)));
    }, [rows, columns, sessionId, database, schema, table]);

    const computeChanges = useCallback((): RowChange[] => {
      const original = rowsRef.current;
      const out: RowChange[] = [];
      const pkIndexes = pkColumns.map((pk) => columns.findIndex((c) => c.name === pk));
      for (const row of data) {
        if (row.state === "new") {
          const values = row.cells
            .map((cell, index) => ({ column: columns[index].name, value: cell.value }))
            .filter((item) => !isNullValue(item.value));
          if (values.length > 0) out.push({ kind: "insert", values });
        } else if (row.state === "deleted" && row.originalIndex !== null) {
          const keys = pkIndexes.map((index) => ({
            column: columns[index].name,
            value: original[row.originalIndex as number][index],
          }));
          out.push({ kind: "delete", keys, before: columns.map((column,index)=>({column:column.name,value:original[row.originalIndex!][index]})) });
        } else if (row.state === "dirty" && row.originalIndex !== null) {
          const originalRow = original[row.originalIndex];
          const changes = row.cells
            .map((cell, index) => ({
              column: columns[index].name,
              oldValue: originalRow[index],
              newValue: cell.value,
            }))
            .filter((change) => !sameValue(change.oldValue, change.newValue));
          if (changes.length > 0) {
            const keys = pkIndexes.map((index) => ({
              column: columns[index].name,
              value: originalRow[index],
            }));
            out.push({ kind: "update", keys, changes });
          }
        }
      }
      return out;
    }, [columns, data, pkColumns]);

    // 用 ref 持有最新实现，避免 valueSetter / 列定义因数据变化而重建（否则会重置列宽）
    const computeChangesRef = useRef(computeChanges);
    computeChangesRef.current = computeChanges;
    const onPendingChangeRef = useRef(onPendingChange);
    onPendingChangeRef.current = onPendingChange;

    useEffect(() => {
      onPendingChangeRef.current?.(computeChangesRef.current());
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data]);

    const updateData = useCallback((updater: (rows: GridRow[]) => GridRow[]) => {
      setData((current) => updater(current.map((row) => ({ ...row, cells: [...row.cells] }))));
    }, []);

    const editableAt = useCallback(
      (row: GridRow | undefined, index: number) => {
        if (!row) return false;
        if (readOnly || invalidRef.current || row.state === "deleted" || row.state === "saved") return false;
        if(row.originalIndex!==null&&(pkColumns.length===0||pkColumns.some(name=>{const value=row.cells[columns.findIndex(c=>c.name===name)]?.value;return !value||value[0]==='null'||isReadOnlyValue(value);})))return false;
        const column = columns[index];
        if (!column || /^(vector|halfvec|sparsevec)(\(|$)/i.test(column.rawType)) return false;
        if (pkColumns.includes(column.name)) return false;
        return !isReadOnlyValue(row.cells[index]?.value);
      },
      [columns, pkColumns, readOnly],
    );

    const inspect = (rowIndex:number,colIndex:number,force=false) => {
      if(invalidRef.current){notify.error(Error('请修正或废弃详情中的无效输入'));return;}
      if(!inspectorOpen&&!force)return;
      const grid=apiRef.current;
      grid?.stopEditing();
      const row=grid?.getDisplayedRowAtIndex(rowIndex)?.data,column=columns[colIndex];
      if(!row||!column)return;
      const value=row.cells[colIndex].value;
      const keys=rowKeys(rowIndex);
      const original=row.originalIndex===null?null:rowsRef.current[row.originalIndex]?.[colIndex];
      const canLoad=['string','enum','json','binary'].includes(column.canonical.kind)&&value[0]!=='null'&&keys&&original&&sameValue(original,value)&&value[0]!=='readonly'&&row.state!=='deleted'&&row.state!=='saved';
      let loadedOriginal:DbValue|undefined;
      const target:InspectorTarget={
        id:row.id+':'+colIndex,name:column.name,rawType:column.rawType,value,column,
        baseline:original??undefined,pending:row.state==='new'||Boolean(original&&!sameValue(original,value)),
        editable:!readOnly&&Boolean(row.originalIndex===null||keys)&&!pkColumns.includes(column.name)&&row.state!=='deleted'&&row.state!=='saved'&&value[0]!=='readonly'&&!/^(vector|halfvec|sparsevec)(\(|$)/i.test(column.rawType),
        load:canLoad?async()=>{const result=await api.cellFullValue(sessionId,database,schema??null,table,column.name,keys);if(result===null)throw Error('目标行不存在，请刷新表格');return result;}:undefined,
        hydrate:full=>{
          const latest=grid?.getRowNode(row.id)?.data;
          if(!latest||latest.originalIndex===null||!sameValue(latest.cells[colIndex].value,value))throw Error('单元格已变化，请重新选中后查看');
          // 只查看时完整值仅随当前详情存活，避免连续浏览长字段使网格基线无限膨胀。
          loadedOriginal=full;
        },
        change:next=>{
          const latest=grid?.getRowNode(row.id)?.data;
          if(!latest||latest.state==='deleted'||latest.state==='saved'||readOnly)throw Error('当前行不可编辑');
          if(loadedOriginal&&latest.originalIndex!==null&&original&&sameValue(rowsRef.current[latest.originalIndex][colIndex],original)){
            rowsRef.current=rowsRef.current.map((cells,i)=>i===latest.originalIndex?cells.map((v,j)=>j===colIndex?loadedOriginal!:v):cells);
          }
          latest.cells[colIndex]=toCell(next);refreshLoadedFind(grid);
          if(latest.state==='clean')latest.state='dirty';
          grid?.refreshCells({force:true});grid?.redrawRows({rowNodes:[grid.getRowNode(row.id)!]});
          onPendingChangeRef.current?.(computeChangesRef.current());
        },
      };
      setInspector(current=>current?.id===target.id?current:target);if(force)setInspectorOpen(true);
    };

    const rowToTsv = (row: GridRow) =>
      (apiRef.current?.getAllDisplayedColumns().filter(c=>/^c\d+$/.test(c.getColId())).map(c=>row.cells[Number(c.getColId().slice(1))])??row.cells)
        .map((cell) => cell.text.replace(/\t/g, " ").replace(/\r?\n/g, " "))
        .join("\t");

    const copyRows = useCallback(async (rows: GridRow[]) => {
      if (rows.length === 0) return 0;
      await api.clipboardWriteText(rows.map(rowToTsv).join("\n"));
      return rows.length;
    }, []);

    const selectedOrFocusedRows = useCallback((): GridRow[] => {
      const gridApi = apiRef.current;
      if (!gridApi) return [];
      const selected = gridApi
        .getSelectedNodes()
        .map((node) => node.data)
        .filter((row): row is GridRow => Boolean(row));
      if (selected.length > 0) return selected;
      const { rowIndex } = focusedRef.current;
      if (rowIndex >= 0) {
        const row = gridApi.getDisplayedRowAtIndex(rowIndex)?.data;
        if (row) return [row];
      }
      return [];
    }, []);

    const pasteInto = useCallback(
      async (rowIndex: number, colIndex: number) => {
        const gridApi = apiRef.current;
        if (!gridApi || readOnly || rowIndex < 0 || colIndex < 0) return 0;
        const text = await api.clipboardReadText();
        if (!text) return 0;
        const lines = text.replace(/\r/g, "").split("\n");
        while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

        const pending: { row: GridRow; index: number; cell: CellState }[] = [];
        const displayed=gridApi.getAllDisplayedColumns().map(c=>c.getColId()).filter(id=>/^c\d+$/.test(id)).map(id=>Number(id.slice(1)));
        const start=displayed.indexOf(colIndex);
        if(start<0)return 0;
        try {
          lines.forEach((line, rowOffset) => {
            const row = gridApi.getDisplayedRowAtIndex(rowIndex + rowOffset)?.data;
            if (!row) return;
            line.split("\t").forEach((raw, colOffset) => {
              const index = displayed[start + colOffset];
              if(index===undefined)return;
              if (!editableAt(row, index)) return;
              const column = columns[index];
              pending.push({ row, index, cell: { value: parseCell(column, raw), text: raw } });
            });
          });
        } catch (error) {
          notify.error(error, "粘贴失败，未修改任何单元格");
          return 0;
        }
        const pasted = pending.length;
        for (const { row, index, cell } of pending) {
          row.cells[index] = cell;
          if (row.state === "clean") row.state = "dirty";
        }
        if (pasted > 0) {
          gridApi.refreshCells({ force: true });
          setTimeout(() => onPendingChangeRef.current?.(computeChangesRef.current()), 0);
        }
        return pasted;
      },
      [columns, editableAt, readOnly, notify],
    );

    const setNullAt = useCallback(
      (rowIndex: number, colIndex: number) => {
        const gridApi = apiRef.current;
        if (!gridApi) return;
        const row = gridApi.getDisplayedRowAtIndex(rowIndex)?.data;
        if (!row || !editableAt(row, colIndex)) return;
        row.cells[colIndex] = { value: ["null", null], text: "" };
        if (row.state === "clean") row.state = "dirty";
        gridApi.refreshCells({ force: true });
        setTimeout(() => onPendingChangeRef.current?.(computeChangesRef.current()), 0);
      },
      [editableAt],
    );

    const copyFocusedCell = useCallback(async (rowIndex: number, colIndex: number) => {
      const gridApi = apiRef.current;
      if (!gridApi) return 0;
      const row = gridApi.getDisplayedRowAtIndex(rowIndex)?.data;
      await api.clipboardWriteText(row?.cells[colIndex]?.text ?? "");
      return 1;
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        finishEditing: () => apiRef.current?.stopEditing(),
        addRow: () => {
          if (readOnly) return;
          const id = `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          newRowFocus.current = id;
          updateData((current) => [
            ...current,
            {
              id,
              originalIndex: null,
              state: "new",
              cells: columns.map(() => ({ value: ["null", null] as DbValue, text: "" })),
            },
          ]);
        },
        deleteSelected: () => {
          if(invalidRef.current){notify.error(Error("请先修正或废弃详情输入"));return;}
          setInspector(null);
          const api = apiRef.current;
          if (!api) return;
          const selected = api.getSelectedNodes().filter((node) => node.data && node.data.state !== "saved");
          if (selected.length === 0) return;
          const ids = new Set(selected.map((node) => node.data!.id));
          updateData((current) =>
            current
              .map((row) =>
                ids.has(row.id)
                  ? row.state === "new"
                    ? null
                    : { ...row, state: "deleted" as RowStateKind }
                  : row,
              )
              .filter((row): row is GridRow => row !== null),
          );
        },
        discard: () => {
          setInspector(null);setInvalid(null);
          setData(current=>current.filter(row=>row.state!=='new').map(row=>row.originalIndex===null?row:{...row,state:'clean',cells:rowsRef.current[row.originalIndex].map(toCell)}));
        },
        acceptChanges: (indexes) => {
          setInspector(null);setInvalid(null);
          const accepted=new Set(indexes);
          let changeIndex=0;
          const baseline:DbValue[][]=[];
          const next:GridRow[]=[];
          for(const row of data){
            const original=row.originalIndex===null?null:rowsRef.current[row.originalIndex];
            const pending=row.state==='new'?row.cells.some(c=>!isNullValue(c.value)):row.state==='deleted'||(row.state==='dirty'&&original!==null&&row.cells.some((c,i)=>!sameValue(c.value,original[i])));
            const submitted=pending&&accepted.has(changeIndex);
            if(pending)changeIndex++;
            if(submitted&&row.state==='deleted')continue;
            const copy={...row,state:submitted?(row.state==='new'?'saved':'clean') as RowStateKind:row.state};
            if(copy.state!=='new'&&copy.state!=='saved'){
              copy.originalIndex=baseline.length;
              baseline.push(submitted?copy.cells.map(c=>c.value):original!);
            }
            next.push(copy);
          }
          rowsRef.current=baseline;
          setData(next);
        },
        getChanges: computeChanges,
        copySelected: async () => copyRows(selectedOrFocusedRows()),
        pasteFromClipboard: async () =>
          pasteInto(focusedRef.current.rowIndex, focusedRef.current.colIndex),
      }),
      [data, columns, computeChanges, copyRows, pasteInto, selectedOrFocusedRows, updateData, readOnly],
    );

    const valueSetter = useCallback(
      (index: number) => (params: ValueSetterParams<GridRow>) => {
        if (!params.data || !editableAt(params.data,index)) return false;
        const text = String(params.newValue ?? "");
        let value: DbValue;
        try {
          value = parseCell(columns[index], text);
        } catch (error) {
          notify.error(error, `${columns[index].name}：输入无效`);
          return false;
        }
        params.data.cells[index] = {
          value,
          text,
        };
        if (params.data.state === "clean") params.data.state = "dirty";
        setTimeout(() => onPendingChangeRef.current?.(computeChangesRef.current()), 0);
        return true;
      },
      [columns,editableAt,notify],
    );

    const primaryKeyIndexes = useMemo(
      () => pkColumns.map(name => ({ name, index: columns.findIndex(column => column.name === name) })),
      [columns, pkColumns],
    );
    const columnDefs = useMemo<ColDef<GridRow>[]>(
      () =>
        columns.map((column, index) => {
          const isPk = pkColumns.includes(column.name);
          return {
            colId: `c${index}`,
            headerName: column.name,
            headerTooltip: `${column.rawType}${isPk ? " · 主键" : ""}`,
            headerComponent: TypeHeader,
            headerComponentParams: { columnType: column.rawType },
            ...initialColumnSizing(column, rows, index),
            // 服务端排序时禁用前端排序（返回 0 保持数据原顺序），避免字符串比较覆盖服务端结果
            comparator: onSortChange ? () => 0 : undefined,
            editable: (params) => editableAt(params.data,index),
            valueGetter: (params) => params.data?.cells[index]?.text ?? "",
            valueFormatter: (params) => cellPreview(String(params.value ?? "")),
            // 编辑器和原文导出必须保留完整值。
            useFormatterForExport: false,
            cellRendererSelector: (params) => {
              const row=params.data,cell=row?.cells[index];
              // 普通值走网格原生文本路径，只有图片候选值才创建 React 组件和补读闭包。
              if (!isImageCandidate(cell?.value)) return undefined;
              const keys=primaryKeyIndexes.map(pk=>({column:pk.name,value:row?.cells[pk.index]?.value}));
              const canLoad=row?.state==='clean' && row.originalIndex!==null && keys.length>0 && keys.every(k=>k.value&&k.value[0]!=='null'&&!isReadOnlyValue(k.value));
              const loadValue=canLoad?(limit:number)=>api.cellFullValue(sessionId,database,schema??null,table,column.name,keys as CellValue[],limit):undefined;
              return { component: ImageCell, params: { value: cell?.value, text: cell?.text ?? '', loadValue, onOpen: () => { if (cell) setImageTarget({ name: column.name, value: cell.value, loadValue }); } } };
            },
            valueSetter: valueSetter(index),
            cellClassRules:{...loadedFindRules,'dw-cell-modified':params=>Boolean(params.data&&params.data.state!=='deleted'&&params.data.originalIndex!==null&&!sameValue(params.data.cells[index].value,rowsRef.current[params.data.originalIndex]?.[index]))},
            cellStyle: (params) => valueCellStyle(column.rawType, params.data?.cells[index]?.value, column.canonical),
          };
        }),
      [columns, onSortChange, pkColumns, primaryKeyIndexes, editableAt, valueSetter, sessionId, database, schema, table],
    );

    const rowClassRules = useMemo<RowClassRules<GridRow>>(
      () => ({
        "dw-row-deleted": (params) => params.data?.state === "deleted",
        "dw-row-new": (params) => params.data?.state === "new",
        "dw-row-dirty": (params) => Boolean(params.data?.state === "dirty" && params.data.originalIndex!==null && params.data.cells.some((cell,i)=>!sameValue(cell.value,rowsRef.current[params.data!.originalIndex!]?.[i]))),
      }),
      [],
    );

    const defaultColDef = useMemo(
      () => ({
        initialWidth: 110,
        minWidth: 110,
        resizable: true,
        sortable: canSort,
        filter: false,
      }),
      [canSort],
    );

    const rowSelection = useMemo(
      () => ({ mode: "multiRow" as const, enableClickSelection: true }),
      [],
    );

    return (
      <div
        style={{ width: "100%", height: "100%" }}
        onKeyDownCapture={(event) => {
          if(imageTarget || (event.target as HTMLElement).closest("input,textarea,[contenteditable=true],.dw-grid-inspector"))return;
          if (!(event.ctrlKey || event.metaKey)) return;
          const key = event.key.toLowerCase();
          if (key === "c") {
            event.preventDefault();
            event.stopPropagation();
            void copyRows(selectedOrFocusedRows());
          } else if (key === "v" && !readOnly) {
            event.preventDefault();
            event.stopPropagation();
            void pasteInto(focusedRef.current.rowIndex, focusedRef.current.colIndex);
          }
        }}
      >
        <GridWorkbench toolbarHost={toolbarHost} grid={layout.grid} tools={<><GridColumns layout={layout} columns={columns}/><GridIconButton showLabel label="单元格详情" icon={<TextFieldRegular/>} aria-pressed={inspectorOpen} appearance={inspectorOpen?"primary":"secondary"} onClick={()=>{if(inspectorOpen){if(invalidRef.current){notify.error(Error("请先修正或废弃详情输入"));return;}setInspectorOpen(false);setInspector(null);}else{setInspectorOpen(true);inspect(focusedRef.current.rowIndex,focusedRef.current.colIndex,true);}}}/></>} inspector={inspectorOpen?<CellInspector target={inspector} onInvalid={setInvalid}/>:null} onClose={()=>{if(invalidRef.current){notify.error(Error("请先修正或废弃详情输入"));return;}setInspectorOpen(false);setInspector(null);}}><AgGridReact<GridRow>
          theme={theme}
          rowData={data}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowId={(params) => params.data.id}
          rowSelection={rowSelection}
          rowClassRules={rowClassRules}
          headerHeight={38}
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
          onCellClicked={event=>{const id=event.column.getColId();inspect(event.rowIndex??-1,Number(id.replace("c","")));}}
          onCellEditingStarted={()=>setInspector(null)}
          onCellEditingStopped={event=>inspect(event.rowIndex??-1,Number(event.column.getColId().replace("c","")))}
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
            const state = params.api
              .getColumnState()
              .filter((item) => item.sort)
              .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
            const specs: SortSpec[] = state
              .map((item) => {
                const index = Number(String(item.colId).replace("c", ""));
                const column = columns[index];
                if (!column) return null;
                return {
                  column: column.name,
                  dir: item.sort as "asc" | "desc",
                };
              })
              .filter((item): item is SortSpec => item !== null);
            onSortChange?.(specs);
            // 刷新表头组件以更新排序箭头（不重建列定义，避免丢失列宽）
            params.api.refreshHeader();
          }}
          onGridReady={(params) => {
            apiRef.current = params.api;layout.setGrid(params.api);
          }}
          onColumnResized={e=>{if(e.finished&&e.source!=="gridInitializing")layout.persist();}}
          onColumnMoved={e=>{if(e.finished)layout.persist();}}
          onColumnPinned={()=>layout.persist()}
          onColumnVisible={()=>layout.persist()}
          onRowDataUpdated={({api: gridApi}) => {
            const id = newRowFocus.current;
            if (!id) return;
            const node = gridApi.getRowNode(id);
            if (!node || node.rowIndex === null) return;
            newRowFocus.current = null;
            gridApi.ensureNodeVisible(node,"bottom");
            const index = columns.findIndex((_,i)=>editableAt(node.data,i));
            if(index < 0) return;
            gridApi.ensureColumnVisible(`c${index}`);
            gridApi.setFocusedCell(node.rowIndex,`c${index}`);
            gridApi.startEditingCell({rowIndex:node.rowIndex,colKey:`c${index}`});
          }}
          onSelectionChanged={(params) =>
            onSelectionChange?.(params.api.getSelectedNodes().length)
          }
          stopEditingWhenCellsLoseFocus
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
            <ContextMenuSurface
              className={`${styles.menu} dw-context-menu`} x={cellMenu.x} y={cellMenu.y}>
              <MenuList>
                {onRelated && <MenuItem onClick={()=>{const row=apiRef.current?.getDisplayedRowAtIndex(cellMenu.rowIndex)?.data;const column=columns[cellMenu.colIndex];setCellMenu(null);if(row&&column)onRelated(column.name,row.cells.map(c=>c.value));}}>查看关联记录…</MenuItem>}
                {onFilterValue && <MenuItem icon={<FilterRegular />} onClick={()=>{const value=apiRef.current?.getDisplayedRowAtIndex(cellMenu.rowIndex)?.data?.cells[cellMenu.colIndex]?.value;const column=columns[cellMenu.colIndex];setCellMenu(null);if(!value||!column)return;if(isReadOnlyValue(value)){notify.error(Error("截断或扩展类型值不能直接用于精确筛选，请使用 SQL"));return;}onFilterValue(column.name,value);}}>按此值筛选（替换条件）</MenuItem>}
                <MenuItem
                  icon={<CopyRegular />}
                  onClick={() => {
                    void copyFocusedCell(cellMenu.rowIndex, cellMenu.colIndex);
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
                <MenuItem icon={<ZoomInRegular/>} onClick={()=>{inspect(cellMenu.rowIndex,cellMenu.colIndex,true);setCellMenu(null);}}>查看/编辑单元格详情</MenuItem>
                {!readOnly && (
                  <MenuItem
                    icon={<ClipboardPasteRegular />}
                    onClick={() => {
                      void pasteInto(cellMenu.rowIndex, cellMenu.colIndex);
                      setCellMenu(null);
                    }}
                  >
                    粘贴
                  </MenuItem>
                )}
                {!readOnly && (
                  <MenuItem
                    icon={<EraserRegular />}
                    onClick={() => {
                      setNullAt(cellMenu.rowIndex, cellMenu.colIndex);
                      setCellMenu(null);
                    }}
                  >
                    设为 NULL
                  </MenuItem>
                )}
              </MenuList>
            </ContextMenuSurface>
          </ContextMenuPortal>
        )}
        {imageTarget&&<ImageValueDialog target={imageTarget} onClose={()=>setImageTarget(null)}/>}

      </div>
    );
  },
);
