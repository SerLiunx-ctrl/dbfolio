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
import { useEffect, useState } from "react";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";
import type { CharsetMeta, Engine } from "../../ipc/types";

const useStyles = makeStyles({
  note: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground4,
    marginTop: "8px",
  },
});

interface Props {
  open: boolean;
  sessionId: string;
  engine: Engine;
  onClose: () => void;
  onDone: () => void;
}

export function CreateDatabaseDialog({
  open,
  sessionId,
  engine,
  onClose,
  onDone,
}: Props) {
  const readOnly=useSessionReadOnly(sessionId);
  const styles = useStyles();
  const notify = useNotify();
  const [name, setName] = useState("");
  const [charsets, setCharsets] = useState<CharsetMeta[]>([]);
  const [charset, setCharset] = useState("");
  const [collations, setCollations] = useState<string[]>([]);
  const [collation, setCollation] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingCharsets, setLoadingCharsets] = useState(false);

  useEffect(() => {
    if (!open || engine !== "mysql") return;
    setLoadingCharsets(true);
    api
      .charsets(sessionId)
      .then(setCharsets)
      .catch((error) => notify.error(error, "读取字符集失败"))
      .finally(() => setLoadingCharsets(false));
  }, [open, engine, sessionId, notify]);

  useEffect(() => {
    if (engine !== "mysql" || !charset) {
      setCollations([]);
      setCollation("");
      return;
    }
    api
      .collations(sessionId, charset)
      .then(setCollations)
      .catch((error) => notify.error(error, "读取排序规则失败"));
  }, [engine, sessionId, charset, notify]);

  const reset = () => {
    setName("");
    setCharset("");
    setCollation("");
  };

  const handleCreate = async () => {
    if(readOnly)return;
    setBusy(true);
    try {
      await api.ddlCreateDatabase(
        sessionId,
        name.trim(),
        engine === "mysql" ? charset || null : null,
        engine === "mysql" ? collation || null : null,
      );
      notify.success("数据库已创建", name.trim());
      reset();
      onClose();
      onDone();
    } catch (error) {
      notify.error(error, "创建数据库失败");
    } finally {
      setBusy(false);
    }
  };

  const charsetLabel = charset || "服务器默认";

  const optionTextStyle: React.CSSProperties = {
    display: "flex",
    gap: "6px",
    alignItems: "baseline",
    minWidth: 0,
    maxWidth: "320px",
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open) {
          reset();
          onClose();
        }
      }}
    >
      <DialogSurface style={{ maxWidth: "520px" }}>
        <DialogBody>
          <DialogTitle>新建数据库</DialogTitle>
          <DialogContent>
            <Field label="数据库名称" required>
              <Input
                value={name}
                placeholder="例如 app_dev"
                onChange={(_, data) => setName(data.value)}
              />
            </Field>
            {engine === "mysql" && (
              <>
                <Field label="字符集">
                  <Dropdown
                    style={{ width: "100%" }}
                    selectedOptions={[charset]}
                    value={loadingCharsets ? "加载中…" : charsetLabel}
                    disabled={loadingCharsets}
                    listbox={{ style: { maxWidth: "360px" } }}
                    onOptionSelect={(_, data) => setCharset(data.optionValue ?? "")}
                  >
                    <Option value="" text="服务器默认">
                      服务器默认
                    </Option>
                    {charsets.map((item) => (
                      <Option
                        key={item.charset}
                        value={item.charset}
                        text={`${item.charset} ${item.defaultCollation ?? ""}`}
                      >
                        <span style={optionTextStyle}>
                          <span style={{ fontWeight: 600, flexShrink: 0 }}>
                            {item.charset}
                          </span>
                          {item.defaultCollation && (
                            <span
                              style={{
                                color: "var(--colorNeutralForeground4)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {item.defaultCollation}
                            </span>
                          )}
                        </span>
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="排序规则">
                  <Dropdown
                    style={{ width: "100%" }}
                    selectedOptions={[collation]}
                    value={collation || "默认（跟随字符集）"}
                    disabled={!charset || collations.length === 0}
                    listbox={{ style: { maxWidth: "360px" } }}
                    onOptionSelect={(_, data) => setCollation(data.optionValue ?? "")}
                  >
                    <Option value="" text="默认（跟随字符集）">
                      默认（跟随字符集）
                    </Option>
                    {collations.map((item) => (
                      <Option key={item} value={item}>
                        {item}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              </>
            )}
            <div className={styles.note}>
              {engine === "mysql"
                ? "将执行 CREATE DATABASE；字符集与排序规则留空使用服务器默认。"
                : "将执行 CREATE DATABASE（PostgreSQL 使用服务器默认编码与排序规则）。"}
            </div>
          </DialogContent>
          <DialogActions>
            <Button
              appearance="secondary"
              onClick={() => {
                reset();
                onClose();
              }}
            >
              取消
            </Button>
            <Button
              appearance="primary"
              disabled={readOnly || busy || !name.trim()}
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
