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
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { useEffect, useMemo, useState } from "react";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";
import type { RedisTab } from "../../stores/useTabStore";
import type { RedisKeyChange, RedisKeyDialog } from "./keyTypes";

const TTL_UNITS = [
  { value: "60", label: "分钟" },
  { value: "3600", label: "小时" },
  { value: "86400", label: "天" },
];

const useStyles = makeStyles({
  note: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground4,
    marginTop: "6px",
  },
  row: {
    display: "flex",
    gap: "8px",
    alignItems: "center",
  },
});

interface Props {
  tab: RedisTab;
  keyName: string | null;
  dialog: RedisKeyDialog | null;
  onClose: () => void;
  onChanged: (change: RedisKeyChange) => void;
}

export function RedisKeyActionDialogs({
  tab,
  keyName,
  dialog,
  onClose,
  onChanged,
}: Props) {
  const readOnly=useSessionReadOnly(tab.sessionId);
  const styles = useStyles();
  const notify = useNotify();
  const databaseIndex = useMemo(() => {
    const text = tab.database.startsWith("db") ? tab.database.slice(2) : tab.database;
    const parsed = Number.parseInt(text, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [tab.database]);

  const [renameDraft, setRenameDraft] = useState("");
  const [ttlValue, setTtlValue] = useState("1");
  const [ttlUnit, setTtlUnit] = useState("3600");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (dialog === "rename" && keyName) setRenameDraft(keyName);
  }, [dialog, keyName]);

  const handleRename = async () => {
    if(readOnly)return;
    if (!keyName) return;
    const next = renameDraft.trim();
    if (!next) return;
    setBusy(true);
    try {
      await api.redisRenameKey(tab.sessionId, databaseIndex, keyName, next);
      notify.success("键已重命名", next);
      onClose();
      onChanged({ renamed: next });
    } catch (error) {
      notify.error(error, "重命名失败");
    } finally {
      setBusy(false);
    }
  };

  const handleTtl = async (ttlMs: number | null) => {
    if(readOnly)return;
    if (!keyName) return;
    setBusy(true);
    try {
      const applied = await api.redisKeyTtl(tab.sessionId, databaseIndex, keyName, ttlMs);
      notify.success(applied >= 0 ? "TTL 已更新" : "已设为永久", keyName);
      onClose();
      onChanged({});
    } catch (error) {
      notify.error(error, "设置 TTL 失败");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if(readOnly)return;
    if (!keyName) return;
    setBusy(true);
    try {
      await api.redisDeleteKey(tab.sessionId, databaseIndex, keyName);
      notify.success("键已删除", keyName);
      onClose();
      onChanged({ deleted: true });
    } catch (error) {
      notify.error(error, "删除失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog
        open={dialog === "rename"}
        onOpenChange={(_, data) => {
          if (!data.open) onClose();
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>重命名键</DialogTitle>
            <DialogContent>
              <Field label="新键名" required>
                <Input
                  value={renameDraft}
                  onChange={(_, data) => setRenameDraft(data.value)}
                />
              </Field>
              <div className={styles.note}>目标键已存在时会拒绝（RENAMENX 语义）。</div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onClose}>
                取消
              </Button>
              <Button
                appearance="primary"
                disabled={readOnly || busy || !renameDraft.trim() || renameDraft === keyName}
                onClick={() => void handleRename()}
              >
                重命名
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={dialog === "ttl"}
        onOpenChange={(_, data) => {
          if (!data.open) onClose();
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>设置 TTL</DialogTitle>
            <DialogContent>
              <div className={styles.row}>
                <Field label="时长">
                  <Input
                    style={{ width: 120 }}
                    value={ttlValue}
                    onChange={(_, data) => setTtlValue(data.value)}
                  />
                </Field>
                <Field label="单位">
                  <Dropdown
                    style={{ minWidth: 110 }}
                    selectedOptions={[ttlUnit]}
                    value={TTL_UNITS.find((unit) => unit.value === ttlUnit)?.label ?? "小时"}
                    onOptionSelect={(_, data) => setTtlUnit(data.optionValue ?? "3600")}
                  >
                    {TTL_UNITS.map((unit) => (
                      <Option key={unit.value} value={unit.value}>
                        {unit.label}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              </div>
              <div className={styles.note}>不填时长可直接「设为永久」。</div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onClose}>
                取消
              </Button>
              <Button disabled={readOnly || busy} onClick={() => void handleTtl(null)}>
                设为永久
              </Button>
              <Button
                appearance="primary"
                disabled={readOnly || busy || !(Number(ttlValue) > 0)}
                onClick={() => {
                  const seconds = Number(ttlValue) * Number(ttlUnit);
                  void handleTtl(Math.round(seconds * 1000));
                }}
              >
                保存
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={dialog === "delete"}
        onOpenChange={(_, data) => {
          if (!data.open) onClose();
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>删除键</DialogTitle>
            <DialogContent>
              确定要删除键「{keyName}」吗？该操作不可恢复。
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onClose}>
                取消
              </Button>
              <Button appearance="primary" disabled={readOnly || busy} onClick={() => void handleDelete()}>
                删除
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
