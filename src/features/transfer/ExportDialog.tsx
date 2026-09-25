import {InfoHint} from '../../common/InfoHint';
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
  Option,
  Spinner,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { FolderOpenRegular } from "@fluentui/react-icons";
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";
import type { ExportFormat, SortSpec } from "../../ipc/types";

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
  hint: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    lineHeight: "18px",
  },
  done: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    fontSize: tokens.fontSizeBase300,
    wordBreak: "break-all",
    userSelect: "text",
  },
});

const FORMATS: Array<{ value: ExportFormat; label: string; ext: string }> = [
  { value: "csv", label: "CSV", ext: "csv" },
  { value: "json", label: "JSON", ext: "json" },
  { value: "xlsx", label: "Excel (.xlsx)", ext: "xlsx" },
];

interface Props {
  open: boolean;
  sessionId: string;
  database: string;
  sql: string;
  sort: SortSpec[];
  pageSize: number;
  pageOffset: number;
  defaultName: string;
  onClose: () => void;
}

export function ExportDialog({
  open,
  sessionId,
  database,
  sql,
  sort,
  pageSize,
  pageOffset,
  defaultName,
  onClose,
}: Props) {
  const styles = useStyles();
  const notify = useNotify();
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [scope, setScope] = useState<"page" | "all">("all");
  const [includeHeader, setIncludeHeader] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ rows: number; path: string } | null>(null);

  const current = FORMATS.find((item) => item.value === format) ?? FORMATS[0];

  const handleExport = async () => {
    const path = await save({
      defaultPath: `${defaultName}.${current.ext}`,
      filters: [{ name: current.label, extensions: [current.ext] }],
    });
    if (!path) return;
    setBusy(true);
    try {
      const outcome = await api.exportData({
        sessionId,
        database,
        sql,
        sort,
        offset: scope === "page" ? pageOffset : 0,
        limit: scope === "page" ? pageSize : null,
        format,
        filePath: path,
        includeHeader,
      });
      setResult({ rows: outcome.rows, path: outcome.path });
      notify.success("导出完成", `${outcome.rows} 行 → ${outcome.path}`);
    } catch (error) {
      notify.error(error, "导出失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open && !busy) {
          setResult(null);
          onClose();
        }
      }}
    >
      <DialogSurface style={{ maxWidth: "480px" }}>
        <DialogBody>
          <DialogTitle>导出数据</DialogTitle>
          <DialogContent>
            <TaskActivity kind="导出" sessionId={sessionId} />
            {result ? (
              <div className={styles.done}>
                <div>已导出 {result.rows.toLocaleString()} 行</div>
                <div>{result.path}</div>
              </div>
            ) : (
              <div className={styles.form}>
                <div className={styles.row}>
                  <Field label="格式">
                    <Dropdown
                      selectedOptions={[format]}
                      value={current.label}
                      onOptionSelect={(_, data) => {
                        if (data.optionValue) {
                          setFormat(data.optionValue as ExportFormat);
                        }
                      }}
                    >
                      {FORMATS.map((item) => (
                        <Option key={item.value} value={item.value}>
                          {item.label}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <Field label="范围">
                    <Dropdown
                      selectedOptions={[scope]}
                      value={scope === "all" ? "全部数据" : "当前页"}
                      onOptionSelect={(_, data) => {
                        if (data.optionValue) {
                          setScope(data.optionValue as "page" | "all");
                        }
                      }}
                    >
                      <Option value="all">全部数据</Option>
                      <Option value="page">当前页</Option>
                    </Dropdown>
                  </Field>
                </div>
                {format === "csv" && (
                  <Checkbox
                    label="包含表头（首行）"
                    checked={includeHeader}
                    onChange={(_, data) => setIncludeHeader(Boolean(data.checked))}
                  />
                )}
                <InfoHint label="导出方式说明">
                  全部数据会分批查询（每批 5000 行）并流式写入文件，适合中大表导出；
                  Excel 大文件会占用较多内存。
                </InfoHint>
              </div>
            )}
          </DialogContent>
          <DialogActions>
            {result ? (
              <>
                <Button
                  appearance="secondary"
                  icon={<FolderOpenRegular />}
                  onClick={() => {
                    revealItemInDir(result.path).catch(() => {});
                  }}
                >
                  打开所在文件夹
                </Button>
                <Button
                  appearance="primary"
                  onClick={() => {
                    setResult(null);
                    onClose();
                  }}
                >
                  完成
                </Button>
              </>
            ) : (
              <>
                <Button appearance="secondary" onClick={onClose} disabled={busy}>
                  取消
                </Button>
                <Button
                  appearance="primary"
                  disabled={busy}
                  icon={busy ? <Spinner size="tiny" /> : undefined}
                  onClick={() => void handleExport()}
                >
                  导出
                </Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
