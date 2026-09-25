import {useSessionReadOnly} from "../../stores/useSessionReadOnly";
import { renderTypeOptions } from "./TypeOptions";
import { defaultColumnType, hasLength, hasPrecision, hasTimePrecision, supportsIdentity, typeHint } from "./columnTypes";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  Spinner,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { AddRegular, DeleteRegular } from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";
import type { ColumnSpec, Engine } from "../../ipc/types";

const useStyles = makeStyles({
  columns: {
    display: "flex", flexDirection: "column", gap: "var(--dw-form-gap)", minWidth: 0,
  },
  columnRow: {
    display: "flex", flexDirection: "column", gap: "var(--dw-form-gap)", minWidth: 0,
    padding: "var(--dw-card-padding)", borderRadius: "6px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  columnHeader: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px",
    fontWeight: tokens.fontWeightSemibold,
  },
  fields: {
    display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))", gap: "var(--dw-form-gap)",
    minWidth: 0,
  },
  control: { minWidth: 0, width: "100%", boxSizing: "border-box" },
  flags: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 16px" },
  sectionHeader: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "10px",
  },
  typeHelp: {
    color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200,
    lineHeight: "20px", marginBottom: "16px",
  },
  sqlList: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    maxHeight: "320px",
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
  switchLabel: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    whiteSpace: "nowrap",
  },
});


function emptyColumn(engine: Engine): ColumnSpec {
  return {
    name: "",
    dataType: defaultColumnType(engine),
    length: 255,
    precision: 10,
    scale: 0,
    nullable: true,
    primaryKey: false,
    autoIncrement: false,
    defaultValue: "",
    comment: "",
  };
}

interface Props {
  open: boolean;
  sessionId: string;
  database: string;
  schema?: string | null;
  engine: Engine;
  onClose: () => void;
  onDone: () => void;
}

export function CreateTableDialog({
  open,
  sessionId,
  database,
  schema,
  engine,
  onClose,
  onDone,
}: Props) {
  const readOnly=useSessionReadOnly(sessionId);
  const styles = useStyles();
  const notify = useNotify();
  const [tableName, setTableName] = useState("");
  const [columns, setColumns] = useState<ColumnSpec[]>([emptyColumn(engine)]);
  const [step, setStep] = useState<"form" | "preview">("form");
  const [statements, setStatements] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTableName("");
    setColumns([emptyColumn(engine)]);
    setStep("form");
    setStatements([]);
  }, [open, engine]);

  const updateColumn = (index: number, patch: Partial<ColumnSpec>) => {
    setColumns((current) =>
      current.map((column, i) => (i === index ? { ...column, ...patch } : column)),
    );
  };

  const spec = {
    type: "createTable" as const,
    schema: schema ?? null,
    table: tableName.trim(),
    columns: columns.map((column) => ({ ...column, name: column.name.trim() })),
  };

  const canNext =
    tableName.trim().length > 0 &&
    columns.length > 0 &&
    columns.every((column) => column.name.trim().length > 0);

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
      notify.success("表已创建", tableName.trim());
      onDone();
      onClose();
    } catch (error) {
      notify.error(error, "创建失败");
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
      <DialogSurface style={{ width: "min(860px, calc(100vw - 32px))", maxWidth: "calc(100vw - 32px)", boxSizing: "border-box" }}>
        <DialogBody>
          <DialogTitle>新建表 · {database}</DialogTitle>
          <DialogContent style={{ minWidth: 0, overflowX: "hidden" }}>
            {step === "form" ? (
              <>
                <Field label="表名" required style={{ marginBottom: 12 }}>
                  <Input
                    value={tableName}
                    placeholder="例如：users"
                    onChange={(_, data) => setTableName(data.value)}
                  />
                </Field>
                <details className={styles.typeHelp}>
                  <summary style={{ cursor: "pointer" }}>类型说明 · {engine === "sqlite" ? "SQLite" : engine === "postgres" ? "PostgreSQL" : "MySQL"}</summary>
                  <div style={{ paddingTop: 6 }}>{typeHint(engine)}</div>
                </details>
                <div className={styles.sectionHeader}>
                  <span style={{ fontWeight: tokens.fontWeightSemibold }}>字段定义 · {columns.length} 列</span>
                  <Button appearance="subtle" size="small" icon={<AddRegular />}
                    onClick={() => setColumns(current => [...current, emptyColumn(engine)])}>添加列</Button>
                </div>
                <div className={styles.columns}>
                  {columns.map((column, index) => (
                    <section key={index} className={styles.columnRow} aria-label={`第 ${index + 1} 列`}>
                      <div className={styles.columnHeader}>
                        <span>字段 {index + 1}</span>
                        <Button appearance="subtle" size="small" icon={<DeleteRegular />}
                          aria-label={`删除第 ${index + 1} 列`} title="删除列" disabled={columns.length <= 1}
                          onClick={() => setColumns(current => current.filter((_, i) => i !== index))} />
                      </div>
                      <div className={styles.fields}>
                        <Field label="列名" required style={{ minWidth: 0 }}>
                          <Input className={styles.control} size="small" value={column.name} placeholder="例如：id"
                            onChange={(_, data) => updateColumn(index, { name: data.value })} />
                        </Field>
                        <Field label="数据类型" style={{ minWidth: 0 }}>
                          <Dropdown className={styles.control} size="small" selectedOptions={[column.dataType]} value={column.dataType}
                            onOptionSelect={(_, data) => { if (data.optionValue) updateColumn(index, {
                              dataType: data.optionValue, precision: hasTimePrecision(engine, data.optionValue) ? 0 : 10,
                              autoIncrement: column.autoIncrement && supportsIdentity(engine, data.optionValue),
                            }); }}>
                            {renderTypeOptions(engine)}
                          </Dropdown>
                        </Field>
                        {(hasLength(column.dataType) || hasPrecision(engine, column.dataType) || hasTimePrecision(engine, column.dataType)) && (
                          <Field label={hasPrecision(engine, column.dataType) ? "精度,小数位" : hasTimePrecision(engine, column.dataType) ? "小数秒精度" : "长度"} style={{ minWidth: 0 }}>
                            <Input className={styles.control} size="small"
                              value={hasPrecision(engine, column.dataType) ? `${column.precision ?? 10},${column.scale ?? 0}`
                                : hasTimePrecision(engine, column.dataType) ? String(column.precision ?? 0) : String(column.length ?? "")}
                              onChange={(_, data) => {
                                if (hasPrecision(engine, column.dataType)) {
                                  const [precision, scale] = data.value.split(",");
                                  updateColumn(index, { precision: Number(precision) || 10, scale: Number(scale) || 0 });
                                } else if (hasTimePrecision(engine, column.dataType)) {
                                  updateColumn(index, { precision: Number(data.value) || 0 });
                                } else updateColumn(index, { length: Number(data.value) || null });
                              }} />
                          </Field>
                        )}
                        <Field label="默认值" style={{ minWidth: 0 }}>
                          <Input className={styles.control} size="small" value={column.defaultValue ?? ""} placeholder="不设置"
                            onChange={(_, data) => updateColumn(index, { defaultValue: data.value })} />
                        </Field>
                      </div>
                      <div className={styles.flags}>
                        <Checkbox label="允许 NULL" checked={column.nullable}
                          onChange={(_, data) => updateColumn(index, { nullable: Boolean(data.checked) })} />
                        <Checkbox label="主键" checked={column.primaryKey}
                          onChange={(_, data) => updateColumn(index, { primaryKey: Boolean(data.checked), autoIncrement: engine === "sqlite" && !data.checked ? false : column.autoIncrement })} />
                        <Checkbox label="自增" checked={column.autoIncrement}
                          disabled={!supportsIdentity(engine, column.dataType) || (engine === "sqlite" && (!column.primaryKey || columns.filter(c => c.primaryKey).length !== 1))}
                          onChange={(_, data) => updateColumn(index, { autoIncrement: Boolean(data.checked) })} />
                      </div>
                    </section>
                  ))}
                </div>
                <Button appearance="subtle" size="small" icon={<AddRegular />} style={{ marginTop: 12 }}
                  onClick={() => setColumns(current => [...current, emptyColumn(engine)])}>添加列</Button>
              </>
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
