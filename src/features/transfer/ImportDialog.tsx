import {useSessionReadOnly} from "../../stores/useSessionReadOnly";
import { TaskActivity } from "../../app/TaskActivity";
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
  Option,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { FolderOpenRegular } from "@fluentui/react-icons";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";
import type { ColumnMeta, ImportOptions, ImportPreview, ImportResult } from "../../ipc/types";

const useStyles = makeStyles({
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--dw-form-gap)",
    paddingTop: "4px",
  },
  fileRow: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: "8px",
    alignItems: "end",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "var(--dw-form-gap)",
  },
  mapping: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    maxHeight: "220px",
    overflowY: "auto",
  },
  mappingRow: {
    display: "grid",
    gridTemplateColumns: "1.2fr 1.2fr",
    gap: "8px",
    alignItems: "center",
  },
  fileColumn: {
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    fontSize: tokens.fontSizeBase200,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  preview: {
    maxHeight: "160px",
    overflow: "auto",
  },
  hint: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    lineHeight: "18px",
  },
  summary: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    fontSize: tokens.fontSizeBase300,
    userSelect: "text",
  },
  error: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorPaletteRedForeground1,
    maxHeight: "80px",
    overflowY: "auto",
    userSelect: "text",
    wordBreak: "break-all",
  },
});

const DELIMITERS = [
  { value: ",", label: "逗号 ," },
  { value: ";", label: "分号 ;" },
  { value: "\t", label: "制表符 Tab" },
  { value: "|", label: "竖线 |" },
];

interface Props {
  open: boolean;
  sessionId: string;
  database: string;
  schema?: string | null;
  table: string;
  columns: ColumnMeta[];
  onClose: () => void;
  onDone: () => void;
}

export function ImportDialog({
  open: isOpen,
  sessionId,
  database,
  schema,
  table,
  columns,
  onClose,
  onDone,
}: Props) {
  const readOnly=useSessionReadOnly(sessionId);
  const styles = useStyles();
  const notify = useNotify();
  const [filePath, setFilePath] = useState("");
  const [delimiter, setDelimiter] = useState(",");
  const [encoding, setEncoding] = useState("utf-8");
  const [hasHeader, setHasHeader] = useState(true);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Array<string | null>>([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setFilePath("");
      setPreview(null);
      setMapping([]);
      setResult(null);
    }
  }, [isOpen]);

  const options = (): ImportOptions => ({
    delimiter,
    encoding,
    hasHeader,
    emptyAsNull,
  });

  const loadPreview = async (path: string) => {
    setLoading(true);
    try {
      const data = await api.importPreview(path, options());
      setPreview(data);
      const autoMapping = data.columns.map((fileColumn) => {
        const match = columns.find(
          (column) => column.name.toLowerCase() === fileColumn.trim().toLowerCase(),
        );
        return match?.name ?? null;
      });
      setMapping(autoMapping);
    } catch (error) {
      notify.error(error, "读取文件失败");
      setPreview(null);
    } finally {
      setLoading(false);
    }
  };

  const pickFile = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: "CSV 文件", extensions: ["csv", "txt", "tsv"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (typeof selected === "string") {
      setFilePath(selected);
      setResult(null);
      await loadPreview(selected);
    }
  };

  const run = async () => {
    if(readOnly)return;
    if (!preview) return;
    setRunning(true);
    try {
      const outcome = await api.importCsv({
        sessionId,
        database,
        schema: schema ?? null,
        table,
        filePath,
        options: options(),
        mapping,
      });
      setResult(outcome);
      if (outcome.error) {
        notify.success("导入部分完成", `成功 ${outcome.inserted} 行`);
      } else {
        notify.success("导入完成", `成功 ${outcome.inserted} 行`);
        onDone();
      }
    } catch (error) {
      notify.error(error, "导入失败");
    } finally {
      setRunning(false);
    }
  };

  const mappedCount = mapping.filter(Boolean).length;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(_, data) => {
        if (!data.open && !running) onClose();
      }}
    >
      <DialogSurface style={{ maxWidth: "720px" }}>
        <DialogBody>
          <DialogTitle>导入 CSV · {table}</DialogTitle>
          <DialogContent>
            <TaskActivity kind="导入" sessionId={sessionId} />
            {result ? (
              <div className={styles.summary}>
                <div>成功插入 {result.inserted.toLocaleString()} 行</div>
                {result.skipped > 0 && <div>跳过 {result.skipped} 行</div>}
                {result.error && <div className={styles.error}>{result.error}</div>}
              </div>
            ) : (
              <div className={styles.form}>
                <Field label="CSV 文件" required>
                  <div className={styles.fileRow}>
                    <Input
                      value={filePath}
                      placeholder="选择要导入的 CSV 文件"
                      onChange={(_, data) => setFilePath(data.value)}
                    />
                    <Button icon={<FolderOpenRegular />} onClick={() => void pickFile()}>
                      浏览
                    </Button>
                  </div>
                </Field>

                <div className={styles.row}>
                  <Field label="分隔符">
                    <Dropdown
                      selectedOptions={[delimiter]}
                      value={
                        DELIMITERS.find((item) => item.value === delimiter)?.label ?? delimiter
                      }
                      onOptionSelect={(_, data) => {
                        if (data.optionValue) setDelimiter(data.optionValue);
                      }}
                    >
                      {DELIMITERS.map((item) => (
                        <Option key={item.label} value={item.value}>
                          {item.label}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <Field label="编码">
                    <Dropdown
                      selectedOptions={[encoding]}
                      value={encoding === "gbk" ? "GBK" : "UTF-8"}
                      onOptionSelect={(_, data) => {
                        if (data.optionValue) setEncoding(data.optionValue);
                      }}
                    >
                      <Option value="utf-8">UTF-8</Option>
                      <Option value="gbk">GBK</Option>
                    </Dropdown>
                  </Field>
                </div>

                <div style={{ display: "flex", gap: 20 }}>
                  <Checkbox
                    label="首行为表头"
                    checked={hasHeader}
                    onChange={(_, data) => setHasHeader(Boolean(data.checked))}
                  />
                  <Checkbox
                    label="空字符串视为 NULL"
                    checked={emptyAsNull}
                    onChange={(_, data) => setEmptyAsNull(Boolean(data.checked))}
                  />
                </div>

                {loading && <Spinner size="tiny" label="读取预览…" />}

                {preview && (
                  <>
                    <div className={styles.hint}>
                      共 {preview.totalRows.toLocaleString()} 行数据，已映射 {mappedCount} 列
                    </div>
                    <div className={styles.mapping}>
                      {preview.columns.map((fileColumn, index) => (
                        <div key={`${fileColumn}-${index}`} className={styles.mappingRow}>
                          <span className={styles.fileColumn} title={fileColumn}>
                            {fileColumn || `第 ${index + 1} 列`}
                          </span>
                          <Dropdown
                            size="small"
                            placeholder="忽略此列"
                            selectedOptions={mapping[index] ? [mapping[index] as string] : []}
                            value={mapping[index] ?? "（忽略）"}
                            onOptionSelect={(_, data) =>
                              setMapping((current) =>
                                current.map((item, i) =>
                                  i === index ? (data.optionValue ?? null) : item,
                                ),
                              )
                            }
                          >
                            <Option value="">（忽略）</Option>
                            {columns.map((column) => (
                              <Option key={column.name} value={column.name}>
                                {column.name}
                              </Option>
                            ))}
                          </Dropdown>
                        </div>
                      ))}
                    </div>

                    {preview.rows.length > 0 && (
                      <div className={styles.preview}>
                        <Table size="extra-small">
                          <TableHeader>
                            <TableRow>
                              {preview.columns.map((column, index) => (
                                <TableHeaderCell key={index}>{column}</TableHeaderCell>
                              ))}
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {preview.rows.slice(0, 5).map((row, rowIndex) => (
                              <TableRow key={rowIndex}>
                                {row.map((value, cellIndex) => (
                                  <TableCell key={cellIndex}>{value}</TableCell>
                                ))}
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            {result ? (
              <Button
                appearance="primary"
                onClick={() => {
                  setResult(null);
                  onClose();
                }}
              >
                完成
              </Button>
            ) : (
              <>
                <Button appearance="secondary" onClick={onClose} disabled={running}>
                  取消
                </Button>
                <Button
                  appearance="primary"
                  disabled={readOnly || !preview || mappedCount === 0 || running}
                  icon={running ? <Spinner size="tiny" /> : undefined}
                  onClick={() => void run()}
                >
                  开始导入
                </Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
