import {InlineColumnRow,type ColumnEdit} from "./InlineColumnRow";
import {usePendingEdit} from "../../stores/useEditGuard";
import {InfoHint} from '../../common/InfoHint';
import { renderTypeOptions } from "./TypeOptions";
import { defaultColumnType, hasPrecision, typeHint } from "./columnTypes";
import {
  Badge,
  Button,
  Checkbox,
  Dropdown,
  Input,
  Menu, MenuTrigger, MenuPopover,
  MenuDivider,
  MenuItem,
  MenuList,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  AddRegular,
  ArrowDownRegular,
  ArrowSortRegular,
  ArrowUpRegular,
  CheckmarkRegular,
  CodeRegular,
  DeleteRegular,
  DismissRegular,
  EditRegular,
  KeyRegular,
  LinkRegular,
} from "@fluentui/react-icons";
import { useState } from "react";
import { ContextMenuPortal, ContextMenuSurface } from "../../app/ContextMenuPortal";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";
import type {
  DdlSpec,
  ColumnMeta,
  ColumnPosition,
  ColumnSpec,
  Engine,
  ForeignKeyMeta,
  IndexMeta,
  TableMeta,
} from "../../ipc/types";
import type { TableTab } from "../../stores/useTabStore";
import { ColumnDialog } from "./ColumnDialog";
import { ConfirmSqlDialog } from "./ConfirmSqlDialog";
import { ForeignKeyDialog } from "./ForeignKeyDialog";
import { IndexDialog } from "./IndexDialog";
import { generateDdl } from "./ddl";

const useStyles = makeStyles({
  wrap: {
    flex: 1,
    width: "100%",
    minWidth: 0,
    boxSizing: "border-box",
    minHeight: 0,
    overflow: "auto",
    padding: "10px 16px 28px",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "10px",
  },
  spacer: { flex: 1 },
  sectionTitle: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    marginBottom: "8px",
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  mono: {
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    fontSize: "12px",
    fontWeight: 400,
  },
  muted: { color: tokens.colorNeutralForeground3 },
  ddl: {
    margin: 0,
    padding: "12px 14px",
    borderRadius: "6px",
    backgroundColor: tokens.colorNeutralBackground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: "20px",
    overflowX: "auto",
    userSelect: "text",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  empty: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    padding: "16px 0",
  },
  addRow: {
    backgroundColor: tokens.colorNeutralBackground3,
  },
  addCell: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
  addHint: {
    fontSize: "10px",
    color: tokens.colorNeutralForeground3,
    whiteSpace: "nowrap",
  },
  menuOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 1198,
  },
  menu: {
    position: "fixed",
    zIndex: 1199,
    minWidth: "180px",
    padding: "4px",
    borderRadius: "6px",
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow16,
  },
});

function nullText(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return value;
}

interface PanelProps {
  tab: TableTab;
  detail: TableMeta;
  engine: Engine;
  readOnly: boolean;
  onChanged: () => void;
  onDropped?: () => void;
}

interface AddDraft {
  position: ColumnPosition;
  name: string;
  dataType: string;
  length: string;
  nullable: boolean;
  defaultValue: string;
}

export function ColumnsPanel({
  tab,
  detail,
  engine,
  readOnly,
  onChanged,
  onDropped,
}: PanelProps) {
  const styles = useStyles();
  const notify = useNotify();
  const [columnDialog, setColumnDialog] = useState<{ column: ColumnMeta } | null>(null);
  const [dropColumn, setDropColumn] = useState<ColumnMeta | null>(null);
  const [dropTable, setDropTable] = useState(false);
  const [draft, setDraft] = useState<AddDraft | null>(null);
  const [rowMenu, setRowMenu] = useState<{
    x: number;
    y: number;
    column: ColumnMeta;
  } | null>(null);

  const canEdit = !readOnly && detail.kind === "table";
  const [flags,setFlags]=useState<Record<string,ColumnEdit>>({});
  const [flagsOpen,setFlagsOpen]=useState(false),[flagsBusy,setFlagsBusy]=useState(false);
  const dirtyFlags=Object.keys(flags).length>0;
  const numeric=(c:ColumnMeta)=>/^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real)\b/i.test(c.rawType);
  const changeFlag=(c:ColumnMeta,key:'nullable'|'unsigned',value:boolean)=>setFlags(old=>{const next={...old};const item={...(old[c.name]??{nullable:c.nullable,...(engine==='mysql'&&numeric(c)?{unsigned:c.unsigned}:{})}),[key]:value};if(item.nullable===c.nullable&&(item.unsigned===undefined||item.unsigned===c.unsigned))delete next[c.name];else next[c.name]=item;return next;});
  const flagSpec:DdlSpec={type:'columnFlags',schema:tab.schema,table:tab.table,changes:Object.entries(flags).map(([name,v])=>({name,...v}))};
  const saveFlags=async()=>{if(readOnly)throw Error('当前会话为只读模式');setFlagsBusy(true);try{await api.ddlApply(tab.sessionId,tab.database,flagSpec,true);setFlags({});onChanged();}finally{setFlagsBusy(false);}};
  usePendingEdit({tabId:tab.id,sessionId:tab.sessionId,label:'列属性',save:saveFlags,discard:()=>setFlags({}),preview:()=>api.ddlPreview(tab.sessionId,tab.database,flagSpec),busy:()=>flagsBusy},dirtyFlags,tab.id+':column-flags');

  const [columnIndex,setColumnIndex]=useState<{initial?:IndexMeta;selectedColumns:string[]}|null>(null);
  const supportsMove = engine !== "postgres";
  const engineLabel =
    engine === "postgres" ? "PostgreSQL" : engine === "sqlite" ? "SQLite" : "MySQL";

  const addIndex = draft
    ? draft.position.first
      ? 0
      : draft.position.after
        ? detail.columns.findIndex((column) => column.name === draft.position.after) + 1
        : detail.columns.length
    : -1;

  const startAdd = (position: ColumnPosition) => {
    setDraft({
      position,
      name: "",
      dataType: defaultColumnType(engine),
      length: "255",
      nullable: true,
      defaultValue: "",
    });
  };

  const confirmAdd = async () => {
    if (!draft || !draft.name.trim()) return;
    const column: ColumnSpec = {
      name: draft.name.trim(),
      dataType: draft.dataType,
      length:
        draft.dataType === "varchar" || draft.dataType === "char"
          ? draft.length
            ? Number(draft.length)
            : 255
          : null,
      precision: hasPrecision(engine, draft.dataType) ? 10 : null,
      scale: hasPrecision(engine, draft.dataType) ? 0 : null,
      nullable: draft.nullable,
      primaryKey: false,
      autoIncrement: false,
      defaultValue: draft.defaultValue.trim() || null,
      comment: null,
    };
    try {
      await api.ddlApply(tab.sessionId, tab.database, {
        type: "addColumn",
        schema: tab.schema,
        table: tab.table,
        column,
        position: draft.position,
      });
      notify.success("列已添加", column.name);
      setDraft(null);
      onChanged();
    } catch (error) {
      notify.error(error, "添加列失败");
    }
  };

  const moveColumn = async (column: ColumnMeta, direction: -1 | 1) => {
    const names = detail.columns.map((item) => item.name);
    const index = names.indexOf(column.name);
    const target = index + direction;
    if (target < 0 || target >= names.length) return;
    const rest = names.filter((name) => name !== column.name);
    const position: ColumnPosition = {
      first: target === 0,
      after: target > 0 ? rest[target - 1] : null,
    };
    try {
      await api.ddlApply(tab.sessionId, tab.database, {
        type: "moveColumn",
        schema: tab.schema,
        table: tab.table,
        column: column.name,
        position,
      });
      notify.success("列顺序已调整", column.name);
      onChanged();
    } catch (error) {
      notify.error(error, "调整列顺序失败");
    }
  };

  const renderAddRow = () => (
    <TableRow key="__add" className={styles.addRow}>
      <TableCell className={styles.muted}>
        <AddRegular fontSize={14} />
      </TableCell>
      <TableCell>
        <Input
          size="small"
          autoFocus
          value={draft?.name ?? ""}
          placeholder="列名"
          onChange={(_, data) => setDraft((current) => current ? { ...current, name: data.value } : current)}
        />
      </TableCell>
      <TableCell colSpan={engine==='mysql'?2:1}>
        <div className={styles.addCell}>
          <Dropdown
            size="small"
            title={typeHint(engine)}
            style={{ minWidth: "110px" }}
            selectedOptions={[draft?.dataType ?? defaultColumnType(engine)]}
            value={draft?.dataType ?? defaultColumnType(engine)}
            onOptionSelect={(_, data) => {
              if (data.optionValue) {
                setDraft((current) =>
                  current ? { ...current, dataType: data.optionValue as string } : current,
                );
              }
            }}
          >
            {renderTypeOptions(engine)}
          </Dropdown>
          {(draft?.dataType === "varchar" || draft?.dataType === "char") && (
            <Input
              size="small"
              style={{ width: 64 }}
              value={draft?.length ?? ""}
              onChange={(_, data) =>
                setDraft((current) => current ? { ...current, length: data.value } : current)
              }
            />
          )}
        </div>
      </TableCell>
      <TableCell>
        <Checkbox
          checked={draft?.nullable ?? true}
          onChange={(_, data) =>
            setDraft((current) =>
              current ? { ...current, nullable: Boolean(data.checked) } : current,
            )
          }
        />
      </TableCell>
      {engine==='mysql'&&<TableCell/>}
      <TableCell>
        <Input
          size="small"
          value={draft?.defaultValue ?? ""}
          placeholder="无"
          onChange={(_, data) =>
            setDraft((current) => current ? { ...current, defaultValue: data.value } : current)
          }
        />
      </TableCell>
      {engine==='mysql'&&<><TableCell/><TableCell/></>}
      <TableCell className={styles.muted}>
        {engine !== "mysql" && (
          <span className={styles.addHint}>{engineLabel} 只能追加到末尾</span>
        )}
      </TableCell>
      <TableCell className={styles.muted} />
      <TableCell>
        <Button
          appearance="primary"
          size="small"
          icon={<CheckmarkRegular />}
          aria-label="确认添加"
          disabled={!draft?.name.trim()}
          onClick={() => void confirmAdd()}
        />
        <Button
          appearance="subtle"
          size="small"
          icon={<DismissRegular />}
          aria-label="取消"
          onClick={() => setDraft(null)}
        />
      </TableCell>
    </TableRow>
  );

  const renderRow = (column: ColumnMeta) => (
    <TableRow
      key={column.name}
      onContextMenu={(event) => {
        event.preventDefault();
        if(dirtyFlags||flagsBusy)return;
        setRowMenu({ x: event.clientX, y: event.clientY, column });
      }}
    >
      <TableCell className={styles.muted}>{column.ordinal}</TableCell>
      <TableCell>
        <span className={styles.mono}>{column.name}</span>
      </TableCell>
      <TableCell>
        <span className={styles.mono}>{column.rawType}</span>
      </TableCell>
      <TableCell><Checkbox size="medium" aria-label={column.name+' 可空'} checked={flags[column.name]?.nullable??column.nullable} disabled={!canEdit||flagsBusy||!!draft||engine==='sqlite'||detail.primaryKey.includes(column.name)||column.autoIncrement} onChange={(_,d)=>changeFlag(column,'nullable',d.checked===true)}/></TableCell>
      {engine==='mysql'&&<TableCell>{numeric(column)?<Checkbox aria-label={column.name+' 无符号'} checked={flags[column.name]?.unsigned??column.unsigned} disabled={!canEdit||flagsBusy||!!draft} onChange={(_,d)=>changeFlag(column,'unsigned',d.checked===true)}/>:<span className={styles.muted}>—</span>}</TableCell>}
      <TableCell>
        <span className={styles.mono}>{nullText(column.defaultValue)}</span>
      </TableCell>
      <TableCell>
        <span style={{ display: "inline-flex", gap: 4 }}>
          {detail.primaryKey.includes(column.name) && (
            <Badge appearance="tint" color="brand" size="small" icon={<KeyRegular />}>
              PK
            </Badge>
          )}
          {column.autoIncrement && (
            <Badge appearance="tint" color="informative" size="small">
              自增
            </Badge>
          )}
        </span>
      </TableCell>
      <TableCell className={styles.muted}>{nullText(column.comment)}</TableCell>
      {canEdit && (
        <TableCell>
          <Button
            appearance="subtle"
            size="small"
            icon={<EditRegular />}
            disabled={dirtyFlags||flagsBusy}
            aria-label="编辑列"
            onClick={() => setColumnDialog({ column })}
          />
          <Button
            appearance="subtle"
            size="small"
            icon={<DeleteRegular />}
            disabled={dirtyFlags||flagsBusy}
            aria-label="删除列"
            onClick={() => setDropColumn(column)}
          />
        </TableCell>
      )}
    </TableRow>
  );

  const rows: React.ReactNode[] = [];
  detail.columns.forEach((column, index) => {
    if (draft && addIndex === index) rows.push(renderAddRow());
    rows.push(engine==='mysql'?<InlineColumnRow key={column.name} column={column} edit={flags[column.name]} primary={detail.primaryKey.includes(column.name)} disabled={!canEdit||flagsBusy||!!draft} onEdit={patch=>setFlags(old=>({...old,[column.name]:{...(old[column.name]??{nullable:column.nullable}),...patch}}))} onDelete={()=>{if(!dirtyFlags)setDropColumn(column);}} onContextMenu={event=>{event.preventDefault();setRowMenu({x:event.clientX,y:event.clientY,column});}}/>:renderRow(column));
  });
  if (draft && addIndex >= detail.columns.length) rows.push(renderAddRow());

  return (
    <div className={styles.wrap}>
      {canEdit && (
        <div className={styles.toolbar}>
          <Button
            size="small"
            icon={<AddRegular />}
            disabled={draft !== null||dirtyFlags||flagsBusy}
            onClick={() =>
              startAdd({
                first: false,
                after: detail.columns[detail.columns.length - 1]?.name ?? null,
              })
            }
          >
            添加列
          </Button>
          <Button size="small" appearance="primary" disabled={!dirtyFlags||flagsBusy} onClick={()=>setFlagsOpen(true)}>保存</Button>
          <Button size="small" disabled={!dirtyFlags||flagsBusy} onClick={()=>setFlags({})}>废弃</Button>
          <span className={styles.addHint}>右键列表可插入到指定位置 / 调整顺序</span>
          <div className={styles.spacer} />
          <Button size="small" icon={<DeleteRegular />} disabled={dirtyFlags||flagsBusy} onClick={() => setDropTable(true)}>
            删除表
          </Button>
        </div>
      )}
      {engine === "sqlite" && <InfoHint label="SQLite 类型说明">声明类型直接来自 SQLite 元数据；varchar(256) 等声明按类型亲和性处理，不自动限制文本长度。</InfoHint>}
      <Table className={"dw-schema-list"+(engine==="mysql"?" dw-inline-columns":"")} size="extra-small" aria-label="列信息">
        <TableHeader>
          <TableRow>
            <TableHeaderCell style={{ width: 36 }}>#</TableHeaderCell>
            <TableHeaderCell>名称</TableHeaderCell>
            <TableHeaderCell>{engine === "sqlite" ? "声明类型" : "类型"}</TableHeaderCell>
            {engine==="mysql"&&<TableHeaderCell>长度/集合</TableHeaderCell>}
            <TableHeaderCell style={{ width: 60 }}>可空</TableHeaderCell>
            {engine==="mysql"&&<TableHeaderCell style={{width:76}}>无符号</TableHeaderCell>}
            <TableHeaderCell>默认值</TableHeaderCell>
            {engine==="mysql"&&<><TableHeaderCell style={{width:76}}>自动增长</TableHeaderCell><TableHeaderCell>ON UPDATE</TableHeaderCell></>}
            <TableHeaderCell style={{width:50}}>键</TableHeaderCell>
            <TableHeaderCell>注释</TableHeaderCell>
            {(canEdit||engine==="mysql") && <TableHeaderCell style={{ width: 60 }}>操作</TableHeaderCell>}
          </TableRow>
        </TableHeader>
        <TableBody>{rows}</TableBody>
      </Table>

      <ConfirmSqlDialog open={flagsOpen} title="保存列属性" sessionId={tab.sessionId} tabId={tab.id} warning="收紧可空性或改变无符号属性可能因现有数据不兼容而失败，并可能重建或锁定表。" loadPreview={()=>api.ddlPreview(tab.sessionId,tab.database,flagSpec)} onApply={saveFlags} onClose={()=>setFlagsOpen(false)} onDone={()=>setFlagsOpen(false)}/>
      {rowMenu && (
        <ContextMenuPortal>
          <div
            className={styles.menuOverlay}
            onClick={() => setRowMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setRowMenu(null);
            }}
          />
          <ContextMenuSurface className={`${styles.menu} dw-context-menu`} x={rowMenu.x} y={rowMenu.y}>
            <MenuList>
              <MenuItem onClick={()=>{void navigator.clipboard.writeText(rowMenu.column.name).catch(error=>notify.error(error,'复制失败'));setRowMenu(null);}}>复制字段名</MenuItem>
              {canEdit && (
                <>
                  <MenuItem
                    disabled={dirtyFlags||flagsBusy||!!draft}
                    icon={<AddRegular />}
                    onClick={() => {
                      const index = detail.columns.findIndex(
                        (item) => item.name === rowMenu.column.name,
                      );
                      startAdd({
                        first: index === 0,
                        after: index > 0 ? detail.columns[index - 1].name : null,
                      });
                      setRowMenu(null);
                    }}
                  >
                    在上方添加
                  </MenuItem>
                  <MenuItem
                    disabled={dirtyFlags||flagsBusy||!!draft}
                    icon={<AddRegular />}
                    onClick={() => {
                      startAdd({ first: false, after: rowMenu.column.name });
                      setRowMenu(null);
                    }}
                  >
                    在下方添加
                  </MenuItem>
                  <MenuDivider />
                  <MenuItem
                    icon={<ArrowUpRegular />}
                    disabled={
                      dirtyFlags||flagsBusy||!!draft||!supportsMove ||
                      detail.columns.findIndex((item) => item.name === rowMenu.column.name) === 0
                    }
                    title={supportsMove ? undefined : "PostgreSQL 不支持调整列顺序"}
                    onClick={() => {
                      void moveColumn(rowMenu.column, -1);
                      setRowMenu(null);
                    }}
                  >
                    向上移动
                  </MenuItem>
                  <MenuItem
                    icon={<ArrowDownRegular />}
                    disabled={
                      dirtyFlags||flagsBusy||!!draft||!supportsMove ||
                      detail.columns.findIndex((item) => item.name === rowMenu.column.name) ===
                        detail.columns.length - 1
                    }
                    title={supportsMove ? undefined : "PostgreSQL 不支持调整列顺序"}
                    onClick={() => {
                      void moveColumn(rowMenu.column, 1);
                      setRowMenu(null);
                    }}
                  >
                    向下移动
                  </MenuItem>
                  <MenuDivider />
                  <MenuItem
                    disabled={dirtyFlags||flagsBusy||!!draft}
                    icon={<DeleteRegular />}
                    onClick={() => {
                      setDropColumn(rowMenu.column);
                      setRowMenu(null);
                    }}
                  >
                    移除
                  </MenuItem>
                  <MenuDivider />
                  <MenuItem disabled={dirtyFlags||flagsBusy||!!draft} onClick={()=>{setColumnIndex({selectedColumns:[rowMenu.column.name]});setRowMenu(null);}}>创建索引</MenuItem>
                  <Menu>
                    <MenuTrigger disableButtonEnhancement><MenuItem disabled={dirtyFlags||flagsBusy||!!draft}>加入索引</MenuItem></MenuTrigger>
                    <MenuPopover><MenuList>
                      {(detail.indexes??[]).filter(i=>!i.primary&&!i.comment&&(!i.method||i.method.toUpperCase()==='BTREE')&&i.columns.every(c=>!c.prefixLen&&detail.columns.some(v=>v.name===c.name))&&!i.columns.some(c=>c.name===rowMenu.column.name)).map(i=><MenuItem key={i.name} onClick={()=>{setColumnIndex({initial:i,selectedColumns:[...i.columns.map(c=>c.name),rowMenu.column.name]});setRowMenu(null);}}>{i.name}</MenuItem>)}
                      <MenuItem disabled>仅支持未包含此列的普通或唯一 B-tree 索引</MenuItem>
                    </MenuList></MenuPopover>
                  </Menu>
                </>
              )}
            </MenuList>
          </ContextMenuSurface>
        </ContextMenuPortal>
      )}

      {columnIndex&&<IndexDialog open sessionId={tab.sessionId} database={tab.database} schema={tab.schema} table={tab.table} columns={detail.columns} initial={columnIndex.initial} selectedColumns={columnIndex.selectedColumns} onClose={()=>setColumnIndex(null)} onDone={onChanged}/>}
      {columnDialog && (
        <ColumnDialog
          open
          mode="edit"
          sessionId={tab.sessionId}
          database={tab.database}
          schema={tab.schema}
          table={tab.table}
          engine={engine}
          initial={columnDialog.column}
          onClose={() => setColumnDialog(null)}
          onDone={onChanged}
        />
      )}

      {dropColumn && (
        <ConfirmSqlDialog
          open
          title={`删除列 · ${dropColumn.name}`}
          sessionId={tab.sessionId}
          warning={`将删除列 ${dropColumn.name} 及其数据，且不可恢复。`}
          loadPreview={() =>
            api.ddlPreview(tab.sessionId, tab.database, {
              type: "dropColumn",
              schema: tab.schema,
              table: tab.table,
              column: dropColumn.name,
            })
          }
          onApply={async () => {
            await api.ddlApply(
              tab.sessionId,
              tab.database,
              {
                type: "dropColumn",
                schema: tab.schema,
                table: tab.table,
                column: dropColumn.name,
              },
              true,
            );
            notify.success("列已删除", dropColumn.name);
          }}
          onClose={() => setDropColumn(null)}
          onDone={onChanged}
        />
      )}

      {dropTable && (
        <ConfirmSqlDialog
          open
          title={`删除表 · ${tab.table}`}
          sessionId={tab.sessionId}
          warning={`将删除表 ${tab.table} 及其全部数据，且不可恢复。`}
          loadPreview={() =>
            api.ddlPreview(tab.sessionId, tab.database, {
              type: "dropTable",
              schema: tab.schema,
              table: tab.table,
            })
          }
          onApply={async () => {
            await api.ddlApply(
              tab.sessionId,
              tab.database,
              { type: "dropTable", schema: tab.schema, table: tab.table },
              true,
            );
            notify.success("表已删除", tab.table);
          }}
          onClose={() => setDropTable(false)}
          onDone={() => {
            onDropped?.();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

export function IndexesPanel({
  tab,
  detail,
  readOnly,
  onChanged,
}: PanelProps) {
  const styles = useStyles();
  const notify = useNotify();
  const [indexDialog, setIndexDialog] = useState<{ initial?: IndexMeta } | null>(null);
  const [dropIndex, setDropIndex] = useState<IndexMeta | null>(null);
  const [indexMenu, setIndexMenu] = useState<{index: IndexMeta; x: number; y: number} | null>(null);
  const canEdit = !readOnly && detail.kind === "table";

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <div className={styles.sectionTitle} style={{ marginBottom: 0 }}>
          <ArrowSortRegular fontSize={16} />
          索引
        </div>
        <div className={styles.spacer} />
        <span title={readOnly ? "当前会话为只读模式" : detail.kind !== "table" ? "视图不支持新建索引" : undefined}>
          <Button disabled={!canEdit} size="small" icon={<AddRegular />} onClick={() => setIndexDialog({})}>
            新建索引
          </Button>
        </span>
      </div>
      {detail.indexes.length === 0 ? (
        <div className={styles.empty}>无索引</div>
      ) : (
        <Table className="dw-schema-list" size="extra-small" aria-label="索引信息">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>名称</TableHeaderCell>
              <TableHeaderCell>类型</TableHeaderCell>
              <TableHeaderCell>列</TableHeaderCell>
              <TableHeaderCell>方法</TableHeaderCell>
              {canEdit && <TableHeaderCell style={{ width: 88 }}>操作</TableHeaderCell>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.indexes.map((index: IndexMeta) => (
              <TableRow key={index.name} onContextMenu={event => { event.preventDefault(); setIndexMenu({index, x: event.clientX, y: event.clientY}); }}>
                <TableCell>
                  <span className={styles.mono}>{index.name}</span>
                </TableCell>
                <TableCell>
                  {index.primary ? "主键" : index.unique ? "唯一" : "普通"}
                </TableCell>
                <TableCell>
                  <span className={styles.mono}>
                    {index.columns
                      .map(
                        (c) =>
                          `${c.name}${c.desc ? " DESC" : ""}${
                            c.prefixLen ? `(${c.prefixLen})` : ""
                          }`,
                      )
                      .join(", ")}
                  </span>
                </TableCell>
                <TableCell className={styles.muted}>{nullText(index.method)}</TableCell>
                {canEdit && (
                  <TableCell>
                    {!index.primary && (
                      <span style={{display: "inline-flex", flexWrap: "nowrap", gap: 2}}>
                        <Button
                          appearance="subtle"
                          size="small"
                          icon={<EditRegular />}
                          aria-label="编辑索引"
                          onClick={() => setIndexDialog({ initial: index })}
                        />
                        <Button
                          appearance="subtle"
                          size="small"
                          icon={<DeleteRegular />}
                          aria-label="删除索引"
                          onClick={() => setDropIndex(index)}
                        />
                      </span>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {indexMenu && <ContextMenuPortal>
        <div className={styles.menuOverlay} onClick={() => setIndexMenu(null)} onContextMenu={event => { event.preventDefault(); setIndexMenu(null); }} />
        <ContextMenuSurface className={`${styles.menu} dw-context-menu`} x={indexMenu.x} y={indexMenu.y}>
          <MenuList>
            <MenuItem onClick={() => { void navigator.clipboard.writeText(indexMenu.index.name).catch(error => notify.error(error, "复制失败")); setIndexMenu(null); }}>复制索引名称</MenuItem>
            <MenuItem onClick={() => { void navigator.clipboard.writeText(indexMenu.index.columns.map(c => c.name).join(", ")).catch(error => notify.error(error, "复制失败")); setIndexMenu(null); }}>复制列名</MenuItem>
            <MenuDivider />
            <MenuItem icon={<EditRegular />} disabled={!canEdit || indexMenu.index.primary} onClick={() => { setIndexDialog({initial: indexMenu.index}); setIndexMenu(null); }}>编辑索引</MenuItem>
            <MenuItem icon={<DeleteRegular />} disabled={!canEdit || indexMenu.index.primary} onClick={() => { setDropIndex(indexMenu.index); setIndexMenu(null); }}>删除索引</MenuItem>
          </MenuList>
        </ContextMenuSurface>
      </ContextMenuPortal>}
      {indexDialog && (
        <IndexDialog
          open
          sessionId={tab.sessionId}
          database={tab.database}
          schema={tab.schema}
          table={tab.table}
          columns={detail.columns}
          initial={indexDialog.initial}
          onClose={() => setIndexDialog(null)}
          onDone={onChanged}
        />
      )}

      {dropIndex && (
        <ConfirmSqlDialog
          open
          title={`删除索引 · ${dropIndex.name}`}
          sessionId={tab.sessionId}
          description={`索引 ${dropIndex.name} 将被删除，不影响表数据。`}
          loadPreview={() =>
            api.ddlPreview(tab.sessionId, tab.database, {
              type: "dropIndex",
              schema: tab.schema,
              table: tab.table,
              name: dropIndex.name,
            })
          }
          onApply={async () => {
            await api.ddlApply(tab.sessionId, tab.database, {
              type: "dropIndex",
              schema: tab.schema,
              table: tab.table,
              name: dropIndex.name,
            });
            notify.success("索引已删除", dropIndex.name);
          }}
          onClose={() => setDropIndex(null)}
          onDone={onChanged}
        />
      )}
    </div>
  );
}

export function ForeignKeysPanel({
  tab,
  detail,
  engine,
  readOnly,
  onChanged,
}: PanelProps) {
  const styles = useStyles();
  const notify = useNotify();
  const [fkDialog, setFkDialog] = useState<{ initial?: ForeignKeyMeta } | null>(null);
  const [dropFk, setDropFk] = useState<ForeignKeyMeta | null>(null);
  const canEdit = !readOnly && detail.kind === "table" && engine !== "sqlite";

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <div className={styles.sectionTitle} style={{ marginBottom: 0 }}>
          <LinkRegular fontSize={16} />
          外键
        </div>
        <div className={styles.spacer} />
        {!readOnly && detail.kind === "table" && engine === "sqlite" && (
          <span className={styles.muted}>SQLite 不支持 ALTER 外键，需重建表</span>
        )}
        <span title={readOnly ? "当前会话为只读模式" : engine === "sqlite" ? "SQLite 修改外键需要重建表" : detail.kind !== "table" ? "视图不支持添加外键" : undefined}>
          <Button disabled={!canEdit} size="small" icon={<AddRegular />} onClick={() => setFkDialog({})}>
            添加外键
          </Button>
        </span>
      </div>
      {detail.foreignKeys.length === 0 ? (
        <div className={styles.empty}>无外键</div>
      ) : (
        <Table className="dw-schema-list" size="extra-small" aria-label="外键信息">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>名称</TableHeaderCell>
              <TableHeaderCell>列</TableHeaderCell>
              <TableHeaderCell>引用</TableHeaderCell>
              <TableHeaderCell>删除规则</TableHeaderCell>
              <TableHeaderCell>更新规则</TableHeaderCell>
              {canEdit && <TableHeaderCell style={{ width: 88, minWidth: 88 }}>操作</TableHeaderCell>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.foreignKeys.map((fk: ForeignKeyMeta) => (
              <TableRow key={fk.name}>
                <TableCell>
                  <span className={styles.mono}>{fk.name}</span>
                </TableCell>
                <TableCell>
                  <span className={styles.mono}>{fk.columns.join(", ")}</span>
                </TableCell>
                <TableCell>
                  <span className={styles.mono}>
                    {fk.refTable}({fk.refColumns.join(", ")})
                  </span>
                </TableCell>
                <TableCell>{fk.onDelete}</TableCell>
                <TableCell>{fk.onUpdate}</TableCell>
                {canEdit && (
                  <TableCell style={{width:88,minWidth:88,whiteSpace:"nowrap"}}>
                    <span style={{display:"inline-flex",flexWrap:"nowrap",alignItems:"center",gap:2}}>
                    <Button
                      appearance="subtle"
                      size="small"
                      icon={<EditRegular />}
                      aria-label="编辑外键"
                      onClick={() => setFkDialog({ initial: fk })}
                    />
                    <Button
                      appearance="subtle"
                      size="small"
                      icon={<DeleteRegular />}
                      aria-label="删除外键"
                      onClick={() => setDropFk(fk)}
                    />
                    </span>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {fkDialog && (
        <ForeignKeyDialog
          open
          sessionId={tab.sessionId}
          database={tab.database}
          schema={tab.schema}
          table={tab.table}
          columns={detail.columns}
          initial={fkDialog.initial}
          onClose={() => setFkDialog(null)}
          onDone={onChanged}
        />
      )}

      {dropFk && (
        <ConfirmSqlDialog
          open
          title={`删除外键 · ${dropFk.name}`}
          sessionId={tab.sessionId}
          description={`外键 ${dropFk.name} 将被删除，不删除数据。`}
          loadPreview={() =>
            api.ddlPreview(tab.sessionId, tab.database, {
              type: "dropForeignKey",
              schema: tab.schema,
              table: tab.table,
              name: dropFk.name,
            })
          }
          onApply={async () => {
            await api.ddlApply(tab.sessionId, tab.database, {
              type: "dropForeignKey",
              schema: tab.schema,
              table: tab.table,
              name: dropFk.name,
            });
            notify.success("外键已删除", dropFk.name);
          }}
          onClose={() => setDropFk(null)}
          onDone={onChanged}
        />
      )}
    </div>
  );
}

export function DdlPanel({ detail, engine }: { detail: TableMeta; engine: Engine }) {
  const styles = useStyles();
  const ddl = detail.rawDdl ?? (detail.kind === "table" ? generateDdl(engine, detail) : null);
  return (
    <div className={styles.wrap}>
      <div className={styles.sectionTitle}>
        <CodeRegular fontSize={16} />
        DDL
      </div>
      {ddl ? (
        <pre className={styles.ddl}>{ddl}</pre>
      ) : (
        <div className={styles.empty}>
          当前视图定义无法从元数据重建（PostgreSQL 视图），可在「列 / 索引 / 外键」页签查看结构详情
        </div>
      )}
    </div>
  );
}
