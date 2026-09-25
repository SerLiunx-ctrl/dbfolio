import {useSessionReadOnly} from "../../stores/useSessionReadOnly";
import {InfoHint} from '../../common/InfoHint';
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
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { useState } from "react";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";
import type { RedisEditOp, RedisFieldPair } from "../../ipc/types";
import type { RedisTab } from "../../stores/useTabStore";

const KIND_OPTIONS = [
  { value: "string", label: "String（字符串）" },
  { value: "list", label: "List（列表，尾部追加）" },
  { value: "set", label: "Set（集合）" },
  { value: "zset", label: "ZSet（有序集合）" },
  { value: "hash", label: "Hash（哈希）" },
  { value: "stream", label: "Stream（流）" },
];

const useStyles = makeStyles({
  row: {
    display: "flex",
    gap: "8px",
    alignItems: "flex-start",
    marginTop: "8px",
  },
  grow: { flex: 1, minWidth: 0 },
  note: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground4,
    marginTop: "6px",
  },
});

interface Props {
  tab: RedisTab;
  open: boolean;
  onClose: () => void;
  onCreated: (key: string) => void;
}

export function RedisNewKeyDialog({ tab, open, onClose, onCreated }: Props) {
  const readOnly=useSessionReadOnly(tab.sessionId);
  const styles = useStyles();
  const notify = useNotify();
  const [keyName, setKeyName] = useState("");
  const [kind, setKind] = useState("string");
  const [value, setValue] = useState("");
  const [zsetScore, setZsetScore] = useState("0");
  const [hashField, setHashField] = useState("");
  const [streamDraft, setStreamDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const databaseIndex = Number.parseInt(
    tab.database.startsWith("db") ? tab.database.slice(2) : tab.database,
    10,
  );

  const reset = () => {
    setKeyName("");
    setKind("string");
    setValue("");
    setZsetScore("0");
    setHashField("");
    setStreamDraft("");
  };

  const buildOp = (): RedisEditOp | null => {
    switch (kind) {
      case "string":
        return { op: "setString", value, ttlMs: null };
      case "list":
        return { op: "listPush", value, head: false };
      case "set":
        return { op: "setAdd", member: value };
      case "zset":
        return { op: "zAdd", member: value, score: Number(zsetScore) };
      case "hash":
        return { op: "hashSet", field: hashField, value };
      case "stream": {
        const fields = streamDraft
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => {
            const separator = line.indexOf("=");
            if (separator <= 0) return null;
            return {
              field: line.slice(0, separator).trim(),
              value: line.slice(separator + 1),
            } as RedisFieldPair;
          });
        if (fields.length === 0 || fields.some((item) => item === null)) {
          notify.error(new Error("格式应为每行 field=value"), "字段格式不正确");
          return null;
        }
        return { op: "streamAdd", fields: fields as RedisFieldPair[] };
      }
      default:
        return null;
    }
  };

  const canSubmit = (() => {
    if (!keyName.trim()) return false;
    if (kind === "hash") return hashField.trim().length > 0;
    if (kind === "zset") return value.length > 0 && Number.isFinite(Number(zsetScore));
    if (kind === "stream") return streamDraft.trim().length > 0;
    return value.length > 0;
  })();

  const handleCreate = async () => {
    if(readOnly)return;
    const op = buildOp();
    if (!op) return;
    setBusy(true);
    try {
      await api.redisEdit(tab.sessionId, databaseIndex, keyName.trim(), op, true);
      notify.success("键已创建", keyName.trim());
      const created = keyName.trim();
      reset();
      onClose();
      onCreated(created);
    } catch (error) {
      notify.error(error, "创建键失败");
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
          <DialogTitle>新建键</DialogTitle>
          <DialogContent>
            <Field label="键名" required>
              <Input
                value={keyName}
                placeholder="例如 user:1001:name"
                onChange={(_, data) => setKeyName(data.value)}
              />
            </Field>
            <div className={styles.row}>
              <Field label="类型" className={styles.grow}>
                <Dropdown
                  selectedOptions={[kind]}
                  value={KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind}
                  onOptionSelect={(_, data) => setKind(data.optionValue ?? "string")}
                >
                  {KIND_OPTIONS.map((option) => (
                    <Option key={option.value} value={option.value}>
                      {option.label}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
            </div>

            {kind === "hash" ? (
              <div className={styles.row}>
                <Field label="字段" required className={styles.grow}>
                  <Input
                    value={hashField}
                    onChange={(_, data) => setHashField(data.value)}
                  />
                </Field>
                <Field label="值" className={styles.grow}>
                  <Input value={value} onChange={(_, data) => setValue(data.value)} />
                </Field>
              </div>
            ) : kind === "stream" ? (
              <div className={styles.row}>
                <Field label="首个条目（每行 field=value）" className={styles.grow}>
                  <Textarea
                    resize="vertical"
                    rows={3}
                    value={streamDraft}
                    placeholder={"action=login\nuser=alice"}
                    onChange={(_, data) => setStreamDraft(data.value)}
                  />
                </Field>
              </div>
            ) : (
              <div className={styles.row}>
                <Field
                  label={
                    kind === "string"
                      ? "值"
                      : kind === "list"
                        ? "首个元素"
                        : kind === "set"
                          ? "首个成员"
                          : "成员"
                  }
                  required={kind !== "string"}
                  className={styles.grow}
                >
                  <Input value={value} onChange={(_, data) => setValue(data.value)} />
                </Field>
                {kind === "zset" && (
                  <Field label="分值" style={{ width: 110 }}>
                    <Input
                      value={zsetScore}
                      onChange={(_, data) => setZsetScore(data.value)}
                    />
                  </Field>
                )}
              </div>
            )}
            <InfoHint label="键创建说明">
              创建时键必须不存在；类型在键创建后不可更改（Redis 语义）。
            </InfoHint>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              取消
            </Button>
            <Button
              appearance="primary"
              disabled={readOnly || busy || !canSubmit}
              onClick={() => void handleCreate()}
            >
              创建
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
