import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Spinner,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { CopyRegular, SaveRegular } from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";
import type { CellValue, DbValue } from "../../ipc/types";
import { ValueEditor } from "./ValueEditor";
import { detailValue } from "./detailValue";
import { confirmEdits, usePendingEdit } from "../../stores/useEditGuard";
import { EnvironmentBadge } from "../sessions/EnvironmentBadge";

const useStyles = makeStyles({
  meta: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginBottom: "6px",
    wordBreak: "break-all",
  },
  hint: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginTop: "6px",
  },
});

interface Props {
  tabId: string;
  open: boolean;
  sessionId: string;
  database: string;
  schema?: string | null;
  table: string;
  column: string;
  keys: CellValue[];
  editable: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function toText(value: DbValue | null): string {
  if (!value || value[0] === "null") return "";
  return String(value[1] ?? "");
}

export function FullValueDialog({
  tabId,
  open,
  sessionId,
  database,
  schema,
  table,
  column,
  keys,
  editable,
  onClose,
  onSaved,
}: Props) {
  const styles = useStyles();
  const notify = useNotify();
  const [original, setOriginal] = useState<DbValue | null>(null);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nullValue,setNullValue]=useState(false);
  const [loadError,setLoadError]=useState(false);
  const dirty=editable && original!==null && (text!==toText(original) || nullValue !== (original[0]==="null"));
  const close=async()=>{if(!saving && await confirmEdits(e=>e.tabId===tabId))onClose();};

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setText("");
    setOriginal(null);
    setLoadError(false);
    let current=true;
    api
      .cellFullValue(sessionId, database, schema ?? null, table, column, keys)
      .then((value) => {
        if(!current)return;
        if(value===null)throw Error("目标行不存在，请刷新表格");
        setOriginal(value);
        setText(toText(value));
        setNullValue(value[0]==="null");
      })
      .catch((error) => {if(current){setLoadError(true);notify.error(error, "读取完整值失败");}})
      .finally(() => {if(current)setLoading(false);});
    return ()=>{current=false;};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = async () => {
    if(loading || saving || loadError || original===null)throw Error("当前内容无法保存");
    setSaving(true);
    try {
      const affected = await api.updateCell(
        sessionId,
        database,
        schema ?? null,
        table,
        column,
        keys,
        original ?? ["null", null],
        detailValue(original, text, nullValue),
      );
      if (affected === 0) {
        throw new Error("目标行已被其他会话修改，未更新任何数据，请刷新后重试");
      } else {
        notify.success("已保存", `${table}.${column}`);
        onSaved();
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };
  usePendingEdit({tabId,sessionId,label:`${database}.${table}.${column}（单元格详情）`,busy:()=>saving,save,discard:()=>{setText(toText(original));setNullValue(original?.[0]==="null");}},dirty || saving);

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open) void close();
      }}
    >
      <DialogSurface style={{ width:"90vw", maxWidth: "1000px" }}>
        <DialogBody>
          <DialogTitle>
            {editable ? "编辑完整值" : "查看完整值"} · {column}
          </DialogTitle>
          <DialogContent>
            <div className={styles.meta}>
              <EnvironmentBadge sessionId={sessionId} />
              {database}.{table} · {keys.map((key) => `${key.column}=${String(key.value[1] ?? "NULL")}`).join(", ")}
              {original ? ` · 类型 ${original[0]}` : ""}
            </div>
            {loading ? (
              <Spinner size="tiny" label="读取中…" />
            ) : (
              <><Checkbox label="NULL（区别于空字符串）" checked={nullValue} disabled={!editable || saving || loadError} onChange={(_,d)=>setNullValue(d.checked===true)} />
              <ValueEditor text={text} onChange={setText} binary={original?.[0]==="bytes"} readOnly={!editable || nullValue || saving || loadError} /></>
            )}
            <div className={styles.hint}>
              {editable
                ? "保存将直接更新该单元格（带旧值并发校验），长度不受网格预览限制。"
                : "此处按主键读取完整值；只读单元格不能保存。"}
            </div>
          </DialogContent>
          <DialogActions>
            <Button
              appearance="secondary"
              icon={<CopyRegular />}
              disabled={loading}
              onClick={() => {
                void navigator.clipboard.writeText(text).catch(() => {
                  api.clipboardWriteText(text).catch(() => {});
                });
              }}
            >
              复制
            </Button>
            <Button appearance="secondary" onClick={()=>void close()} disabled={saving}>
              关闭
            </Button>
            {editable && (
              <Button
                appearance="primary"
                icon={saving ? <Spinner size="tiny" /> : <SaveRegular />}
                disabled={loading || saving || loadError || !dirty}
                onClick={() => void save().catch(e=>notify.error(e,"保存失败"))}
              >
                保存
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
