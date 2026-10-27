import {useSessionReadOnly} from "../../stores/useSessionReadOnly";
import {useSessionStore} from "../../stores/useSessionStore";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  Option,
  Spinner,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { useEffect, useState } from "react";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";
import type { ColumnMeta, DdlSpec, ForeignKeyMeta, TableRef } from "../../ipc/types";

const useStyles = makeStyles({
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--dw-form-gap)",
    paddingTop: "4px",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "var(--dw-form-gap)",
  },
  sqlList: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    maxHeight: "240px",
    overflow: "auto",
    marginTop: "8px",
  },
  sql: {
    margin: 0,
    padding: "10px 12px",
    borderRadius: "6px",
    backgroundColor: tokens.colorNeutralBackground3,
    fontSize: tokens.fontSizeBase200,
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    userSelect: "text",
  },
});

const ACTIONS = ["NO ACTION", "CASCADE", "SET NULL", "RESTRICT", "SET DEFAULT"];

interface Props {
  open: boolean;
  sessionId: string;
  database: string;
  schema?: string | null;
  table: string;
  columns: ColumnMeta[];
  initial?: ForeignKeyMeta;
  onClose: () => void;
  onDone: () => void;
}

export function ForeignKeyDialog({
  open,
  sessionId,
  database,
  schema,
  table,
  columns,
  initial,
  onClose,
  onDone,
}: Props) {
  const readOnly=useSessionReadOnly(sessionId);
  const engine=useSessionStore(s=>s.sessions.find(session=>session.id===sessionId)?.engine);
  const styles = useStyles();
  const notify = useNotify();
  const [name, setName] = useState("");
  const [localColumns, setLocalColumns] = useState<string[]>([]);
  const [refTable, setRefTable] = useState("");
  const [refSchema, setRefSchema] = useState<string | null>(null);
  const [refColumns, setRefColumns] = useState<string[]>([]);
  const [referenceColumns, setReferenceColumns] = useState<ColumnMeta[]>([]);
  const [onDelete, setOnDelete] = useState("NO ACTION");
  const [onUpdate, setOnUpdate] = useState("NO ACTION");
  const [tables, setTables] = useState<TableRef[]>([]);
  const [step, setStep] = useState<"form" | "preview">("form");
  const [statements, setStatements] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setLocalColumns(initial?.columns ?? []);
    setRefTable(initial?.refTable ?? "");
    setRefSchema(initial?.refSchema ?? (engine === "postgres" ? schema ?? "public" : null));
    setRefColumns(initial?.refColumns ?? []);
    setOnDelete(initial?.onDelete ?? "NO ACTION");
    setOnUpdate(initial?.onUpdate ?? "NO ACTION");
    setStep("form");
    setStatements([]);
    let alive=true;
    api
      .listTables(sessionId, database)
      .then((list) => {if(alive)setTables(list.filter((item) => item.kind === "table"));})
      .catch(() => {if(alive)setTables([]);});
    return()=>{alive=false;};
  }, [open, initial, sessionId, database, schema, engine]);

  useEffect(()=>{
    let alive=true;setReferenceColumns([]);
    if(open&&refTable)void api.tableDetail(sessionId,database,refTable,refSchema).then(meta=>{if(alive)setReferenceColumns(meta.columns);}).catch(()=>{});
    return()=>{alive=false;};
  },[open,sessionId,database,refTable,refSchema]);

  const isEdit = Boolean(initial);

  const refColumnList = refColumns;
  const selectedRef=JSON.stringify([refSchema??"",refTable]);
  const referenceLabel=(refSchema?refSchema+".":"")+refTable;

  const spec: DdlSpec = isEdit
    ? {
        type: "replaceForeignKey",
        schema: schema ?? null,
        table,
        name: name.trim(),
        oldName: initial?.name ?? "",
        columns: localColumns,
        refTable,
        refSchema,
        refColumns: refColumnList,
        onDelete,
        onUpdate,
      }
    : {
        type: "addForeignKey",
        schema: schema ?? null,
        table,
        name: name.trim(),
        columns: localColumns,
        refTable,
        refSchema,
        refColumns: refColumnList,
        onDelete,
        onUpdate,
      };

  const canNext =
    name.trim().length > 0 &&
    localColumns.length > 0 &&
    refTable.length > 0 &&
    localColumns.length === refColumnList.length;

  const goPreview = async () => {
    setBusy(true);
    try {
      setStatements(await api.ddlPreview(sessionId, database, spec));
      setStep("preview");
    } catch (error) {
      notify.error(error, "生成预览失败");
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if(readOnly)return;
    setBusy(true);
    try {
      await api.ddlApply(sessionId, database, spec);
      notify.success(isEdit ? "外键已更新" : "外键已添加", name.trim());
      onDone();
      onClose();
    } catch (error) {
      notify.error(error, isEdit ? "更新外键失败" : "添加外键失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open) onClose();
      }}
    >
      <DialogSurface style={{ maxWidth: "560px" }}>
        <DialogBody>
          <DialogTitle>{isEdit ? "编辑外键" : "添加外键"} · {table}</DialogTitle>
          <DialogContent>
            {step === "form" ? (
              <div className={styles.form}>
                <Field label="外键名" required>
                  <Input
                    value={name}
                    placeholder="例如：fk_table_ref"
                    onChange={(_, data) => setName(data.value)}
                  />
                </Field>
                <Field label="本地列（多选，按选择顺序）" required>
                  <Dropdown
                    multiselect
                    selectedOptions={localColumns}
                    value={localColumns.length > 0 ? localColumns.join(", ") : "选择列"}
                    onOptionSelect={(_, data) => setLocalColumns(data.selectedOptions)}
                  >
                    {columns.map((column) => (
                      <Option key={column.name} value={column.name}>
                        {column.name}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <div className={styles.row}>
                  <Field label="引用表" required>
                    <Dropdown
                      aria-label="引用表"
                      selectedOptions={[selectedRef]}
                      value={refTable ? referenceLabel : "选择表"}
                      onOptionSelect={(_, data) => {
                        if (data.optionValue) {const [selectedSchema,selectedTable]=JSON.parse(data.optionValue);setRefTable(selectedTable);setRefSchema(selectedSchema||null);setRefColumns([]);}
                      }}
                    >
                      {tables.map((item) => (
                        <Option key={JSON.stringify([item.schema??"",item.name])} value={JSON.stringify([item.schema??"",item.name])}>
                          {(item.schema?item.schema+".":"")+item.name}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <Field
                    label={`引用列（多选，${localColumns.length} 列）`}
                    required
                  >
                    <Dropdown aria-label="引用列" multiselect selectedOptions={refColumns} value={refColumns.join(", ")||"选择引用列"} onOptionSelect={(_,data)=>setRefColumns(data.selectedOptions)}>
                      {[...new Set([...referenceColumns.map(c=>c.name),...refColumns])].map(name=><Option key={name} value={name}>{name}</Option>)}
                    </Dropdown>
                  </Field>
                </div>
                <div className={styles.row}>
                  <Field label="删除时">
                    <Dropdown
                      selectedOptions={[onDelete]}
                      value={onDelete}
                      onOptionSelect={(_, data) => {
                        if (data.optionValue) setOnDelete(data.optionValue);
                      }}
                    >
                      {ACTIONS.filter(action=>engine!=="mysql"||action!=="SET DEFAULT").map((action) => (
                        <Option key={action} value={action}>
                          {action}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <Field label="更新时">
                    <Dropdown
                      selectedOptions={[onUpdate]}
                      value={onUpdate}
                      onOptionSelect={(_, data) => {
                        if (data.optionValue) setOnUpdate(data.optionValue);
                      }}
                    >
                      {ACTIONS.filter(action=>engine!=="mysql"||action!=="SET DEFAULT").map((action) => (
                        <Option key={action} value={action}>
                          {action}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                </div>
              </div>
            ) : (
              <div className={styles.sqlList}>
                {statements.map((statement, index) => (
                  <pre key={index} className={styles.sql}>
                    {statement}
                  </pre>
                ))}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            {step === "form" ? (
              <>
                <Button appearance="secondary" onClick={onClose}>
                  取消
                </Button>
                <Button
                  appearance="primary"
                  disabled={!canNext || busy}
                  icon={busy ? <Spinner size="tiny" /> : undefined}
                  onClick={() => void goPreview()}
                >
                  下一步：预览 SQL
                </Button>
              </>
            ) : (
              <>
                <Button appearance="secondary" onClick={() => setStep("form")} disabled={busy}>
                  上一步
                </Button>
                <Button
                  appearance="primary"
                  disabled={readOnly || busy}
                  title={readOnly?"只读会话不能修改结构":undefined}
                  icon={busy ? <Spinner size="tiny" /> : undefined}
                  onClick={() => void apply()}
                >
                  执行
                </Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
