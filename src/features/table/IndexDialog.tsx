import {useSessionReadOnly} from "../../stores/useSessionReadOnly";
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
  Switch,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { useEffect, useState } from "react";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";
import type { ColumnMeta, DdlSpec, IndexMeta } from "../../ipc/types";

const useStyles = makeStyles({
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--dw-form-gap)",
    paddingTop: "4px",
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

interface Props {
  open: boolean;
  sessionId: string;
  database: string;
  schema?: string | null;
  table: string;
  columns: ColumnMeta[];
  initial?: IndexMeta;
  selectedColumns?: string[];
  onClose: () => void;
  onDone: () => void;
}

export function IndexDialog({
  open,
  sessionId,
  database,
  schema,
  table,
  columns,
  initial,
  selectedColumns,
  onClose,
  onDone,
}: Props) {
  const readOnly=useSessionReadOnly(sessionId);
  const styles = useStyles();
  const notify = useNotify();
  const [name, setName] = useState("");
  const [unique, setUnique] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [step, setStep] = useState<"form" | "preview">("form");
  const [statements, setStatements] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? (selectedColumns?.length ? "idx_"+table+"_"+selectedColumns.join("_") : ""));
    setUnique(initial?.unique ?? false);
    setSelected(selectedColumns ?? initial?.columns.map((column) => column.name) ?? []);
    setStep("form");
    setStatements([]);
  }, [open, initial, selectedColumns]);

  const isEdit = Boolean(initial);

  const spec: DdlSpec = isEdit
    ? {
        type: "replaceIndex",
        schema: schema ?? null,
        table,
        name: name.trim(),
        oldName: initial?.name ?? "",
        columns: selected.map((column) => ({
          name: column,
          desc:
            initial?.columns.find((item) => item.name === column)?.desc ?? false,
        })),
        unique,
      }
    : {
        type: "createIndex",
        schema: schema ?? null,
        table,
        name: name.trim(),
        columns: selected.map((column) => ({ name: column, desc: false })),
        unique,
      };

  const canNext = name.trim().length > 0 && selected.length > 0;

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
      notify.success(isEdit ? "索引已更新" : "索引已创建", name.trim());
      onDone();
      onClose();
    } catch (error) {
      notify.error(error, isEdit ? "更新索引失败" : "创建索引失败");
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
      <DialogSurface style={{ maxWidth: "520px" }}>
        <DialogBody>
          <DialogTitle>{isEdit ? "编辑索引" : "新建索引"} · {table}</DialogTitle>
          <DialogContent>
            {step === "form" ? (
              <div className={styles.form}>
                <Field label="索引名" required>
                  <Input
                    value={name}
                    placeholder="例如：idx_table_column"
                    onChange={(_, data) => setName(data.value)}
                  />
                </Field>
                <Field label="列（可多选，按选择顺序）" required>
                  <Dropdown
                    multiselect
                    selectedOptions={selected}
                    value={selected.length > 0 ? selected.join(", ") : "选择列"}
                    onOptionSelect={(_, data) => setSelected(data.selectedOptions)}
                  >
                    {columns.map((column) => (
                      <Option key={column.name} value={column.name}>
                        {column.name}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Switch
                  label="唯一索引"
                  checked={unique}
                  onChange={(_, data) => setUnique(data.checked)}
                />
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
