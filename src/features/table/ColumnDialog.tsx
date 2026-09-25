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
  Switch,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { useEffect, useMemo, useState } from "react";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";
import type { ColumnMeta, ColumnSpec, Engine } from "../../ipc/types";

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
  row3: {
    display: "grid",
    gridTemplateColumns: "1.5fr 0.8fr 0.8fr",
    gap: "var(--dw-form-gap)",
  },
  sqlList: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    maxHeight: "260px",
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
  switches: {
    display: "flex",
    gap: "20px",
    flexWrap: "wrap",
  },
});


export function specFromColumn(column: ColumnMeta, engine: Engine): ColumnSpec {
  const canonical = column.canonical;
  let dataType = "varchar";
  let length: number | null = 255;
  let precision: number | null = 10;
  let scale: number | null = 0;
  switch (canonical.kind) {
    case "bool":
      dataType = "bool";
      break;
    case "int":
      dataType =
        canonical.bits === 64
          ? "bigint"
          : canonical.bits === 16
            ? "smallint"
            : canonical.bits === 8
              ? "tinyint"
              : "int";
      break;
    case "decimal":
      dataType = "decimal";
      precision = canonical.precision ?? 10;
      scale = canonical.scale ?? 0;
      break;
    case "float":
      dataType = canonical.bits === 32 ? "float" : "double";
      break;
    case "string":
      dataType = canonical.len !== null && canonical.len !== undefined ? "varchar" : "text";
      length = canonical.len ?? 255;
      break;
    case "binary":
      dataType = "blob";
      break;
    case "date":
      dataType = "date";
      break;
    case "time":
      dataType = "time";
      precision = canonical.precision ?? 0;
      scale = null;
      break;
    case "dateTime":
      dataType = canonical.tz ? "timestamp" : "datetime";
      precision = canonical.precision ?? 0;
      scale = null;
      break;
    case "json":
      dataType = "json";
      break;
    case "uuid":
      dataType = "uuid";
      break;
    default:
      // 未知类型（枚举、数组、自定义类型等）保留原始类型文本，避免改列时误转为 varchar
      dataType = column.rawType?.trim() || "varchar";
  }
  // 原始类型优先，避免 JSONB、时区、ENUM、数组和 SQLite 声明被规范化丢失。
  if (column.rawType?.trim()) {
    dataType = column.rawType.trim();
    length = null; precision = null; scale = null;
  } else if (engine === "postgres") {
    dataType = ({ int: "integer", float: "real", double: "double precision", blob: "bytea", json: "jsonb", timestamp: "timestamptz", datetime: "timestamp" } as Record<string,string>)[dataType] ?? dataType;
  }
  return {
    preserveType: Boolean(column.rawType?.trim()),
    name: column.name,
    dataType,
    length,
    precision,
    scale,
    nullable: column.nullable,
    primaryKey: false,
    autoIncrement: column.autoIncrement,
    defaultValue: column.defaultValue ?? null,
    comment: column.comment ?? null,
  };
}

interface Props {
  open: boolean;
  mode: "add" | "edit";
  sessionId: string;
  database: string;
  schema?: string | null;
  table: string;
  engine: Engine;
  initial?: ColumnMeta;
  onClose: () => void;
  onDone: () => void;
}

export function ColumnDialog({
  open,
  mode,
  sessionId,
  database,
  schema,
  table,
  engine,
  initial,
  onClose,
  onDone,
}: Props) {
  const readOnly=useSessionReadOnly(sessionId);
  const styles = useStyles();
  const notify = useNotify();
  const [spec, setSpec] = useState<ColumnSpec>({
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
  });
  const [step, setStep] = useState<"form" | "preview">("form");
  const [statements, setStatements] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep("form");
    setStatements([]);
    if (mode === "edit" && initial) {
      setSpec(specFromColumn(initial, engine));
    } else {
      setSpec({
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
      });
    }
  }, [open, mode, initial, engine]);

  const ddlSpec = useMemo(() => {
    const column: ColumnSpec = { ...spec, name: spec.name.trim() };
    return mode === "add"
      ? ({ type: "addColumn", schema: schema ?? null, table, column } as const)
      : ({ type: "modifyColumn", schema: schema ?? null, table, column } as const);
  }, [mode, schema, spec, table]);

  const canNext = spec.name.trim().length > 0;

  const goPreview = async () => {
    setBusy(true);
    try {
      setStatements(await api.ddlPreview(sessionId, database, ddlSpec));
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
      await api.ddlApply(sessionId, database, ddlSpec);
      notify.success(mode === "add" ? "列已添加" : "列已修改", `${table}.${spec.name}`);
      onDone();
      onClose();
    } catch (error) {
      notify.error(error, "执行失败");
    } finally {
      setBusy(false);
    }
  };

  const isLength = !spec.preserveType && hasLength(spec.dataType);
  const isDecimal = !spec.preserveType && hasPrecision(engine, spec.dataType);
  const isTemporal =
    !spec.preserveType && hasTimePrecision(engine, spec.dataType);

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open) onClose();
      }}
    >
      <DialogSurface style={{ maxWidth: "560px" }}>
        <DialogBody>
          <DialogTitle>{mode === "add" ? "添加列" : `编辑列 · ${initial?.name}`}</DialogTitle>
          <DialogContent>
            {step === "form" ? (
              <div className={styles.form}>
                <Field label="列名" required>
                  <Input
                    value={spec.name}
                    disabled={mode === "edit"}
                    onChange={(_, data) => setSpec({ ...spec, name: data.value })}
                  />
                </Field>
                <Field label={`类型（${engine}）`} hint={<details><summary>类型说明</summary>{typeHint(engine)}</details>}>
                  <Dropdown
                    selectedOptions={[spec.dataType]}
                    value={spec.dataType}
                    onOptionSelect={(_, data) => {
                      if (data.optionValue) {
                        setSpec({ ...spec, dataType: data.optionValue, preserveType: false, length: 255, precision: hasTimePrecision(engine, data.optionValue) ? 0 : 10, scale: 0, autoIncrement: spec.autoIncrement && supportsIdentity(engine, data.optionValue) });
                      }
                    }}
                  >
                    {renderTypeOptions(engine, spec.dataType)}
                  </Dropdown>
                </Field>
                {isDecimal ? (
                  <div className={styles.row}>
                    <Field label="精度">
                      <Input
                        value={String(spec.precision ?? "")}
                        onChange={(_, data) =>
                          setSpec({ ...spec, precision: Number(data.value) || null })
                        }
                      />
                    </Field>
                    <Field label="小数位">
                      <Input
                        value={String(spec.scale ?? "")}
                        onChange={(_, data) =>
                          setSpec({ ...spec, scale: Number(data.value) || null })
                        }
                      />
                    </Field>
                  </div>
                ) : isLength ? (
                  <Field label="长度">
                    <Input
                      value={String(spec.length ?? "")}
                      onChange={(_, data) =>
                        setSpec({ ...spec, length: Number(data.value) || null })
                      }
                    />
                  </Field>
                ) : isTemporal ? (
                  <Field label="小数秒精度">
                    <Input
                      value={String(spec.precision ?? 0)}
                      onChange={(_, data) =>
                        setSpec({ ...spec, precision: Number(data.value) || 0 })
                      }
                    />
                  </Field>
                ) : null}
                <Field label="默认值（留空表示无；字符串将自动加引号）">
                  <Input
                    value={spec.defaultValue ?? ""}
                    onChange={(_, data) => setSpec({ ...spec, defaultValue: data.value })}
                  />
                </Field>
                {engine === "mysql" && (
                  <Field label="注释">
                    <Input
                      value={spec.comment ?? ""}
                      onChange={(_, data) => setSpec({ ...spec, comment: data.value })}
                    />
                  </Field>
                )}
                <div className={styles.switches}>
                  <Switch
                    label="允许 NULL"
                    checked={spec.nullable}
                    onChange={(_, data) => setSpec({ ...spec, nullable: data.checked })}
                  />
                  <Switch
                    label="自增"
                    disabled={engine === "sqlite" || !supportsIdentity(engine, spec.dataType.toLowerCase())}
                    checked={spec.autoIncrement}
                    onChange={(_, data) => setSpec({ ...spec, autoIncrement: data.checked })}
                  />
                  {mode === "edit" && (
                    <Checkbox
                      label="设为主键"
                      checked={spec.primaryKey}
                      onChange={(_, data) =>
                        setSpec({ ...spec, primaryKey: Boolean(data.checked) })
                      }
                    />
                  )}
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
