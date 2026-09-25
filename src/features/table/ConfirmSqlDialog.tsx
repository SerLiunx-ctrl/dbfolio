import {useObjectPreferences} from '../../stores/useObjectPreferences';
import { TaskActivity } from "../../app/TaskActivity";
import type { TaskKind } from "../../stores/useTaskStore";
import {
  Button, Input,
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
import { useEffect, useState } from "react";
import { useNotify } from "../../app/toast";
import { EnvironmentBadge } from "../sessions/EnvironmentBadge";
import { useSessionStore } from "../../stores/useSessionStore";

const useStyles = makeStyles({
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
  warning: {
    padding: "8px 12px",
    borderRadius: "6px",
    backgroundColor: tokens.colorPaletteRedBackground1,
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
  loading: {
    display: "flex",
    justifyContent: "center",
    padding: "24px 0",
  },
});

interface Props {
  tabId?:string;
  visible?:boolean;
  taskKind?: TaskKind;
  open: boolean;
  title: string;
  sessionId?: string;
  description?: string;
  warning?: string;
  loadPreview: () => Promise<string[]>;
  onApply: () => Promise<void>;
  onClose: () => void;
  onDone: () => void;
  /** 仅查看（不执行）：隐藏执行按钮，只显示关闭 */
  informativeOnly?: boolean;
}

export function ConfirmSqlDialog({
  open,
  tabId,
  visible=true,
  title,
  sessionId,
  description,
  warning,
  loadPreview,
  onApply,
  onClose,
  onDone,
  informativeOnly = false,
  taskKind,
}: Props) {
  const styles = useStyles();
  const notify = useNotify();
  const session = useSessionStore(state => state.sessions.find(item => item.id === sessionId));
  const [statements, setStatements] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const production=useObjectPreferences(s=>Boolean(sessionId)&&s.environments[sessionId!]==='production');
  const [productionText,setProductionText]=useState('');
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setConfirmed(false);setProductionText("");
    setLoading(true);
    loadPreview()
      .then(setStatements)
      .catch((error) => {
        notify.error(error, "生成预览失败");
        onClose();
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const readOnly=Boolean(sessionId)&&(!session||session.readOnly);
  const apply = async () => {
    if(readOnly||(production&&productionText!==session?.name))return;
    setApplying(true);
    try {
      await onApply();
      onDone();
      onClose();
    } catch (error) {
      notify.error(error, "执行失败");
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog
      modalType={taskKind==="同步"?"non-modal":"modal"}
      open={open&&visible}
      onOpenChange={(_, data) => {
        if (!data.open && !applying && !loading) onClose();
      }}
    >
      <DialogSurface style={{ maxWidth: "640px" }}>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            {taskKind && <TaskActivity kind={taskKind} sessionId={sessionId} tabId={tabId} />}
            {session && <p>目标会话：{session.name}<EnvironmentBadge sessionId={session.id} /></p>}
            {description && <div style={{ marginBottom: 8 }}>{description}</div>}
            {warning && <div className={styles.warning}>{warning}</div>}
            {loading ? (
              <div className={styles.loading}>
                <Spinner size="tiny" label="生成 SQL 预览…" />
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
            {warning && (
              <Checkbox
                style={{ marginTop: 12 }}
                checked={confirmed}
                onChange={(_, data) => setConfirmed(Boolean(data.checked))}
                label="我已了解风险，确认执行"
              />
            )}
            {production&&!informativeOnly&&<Input size="small" aria-label="生产会话确认" placeholder={'输入生产会话名称 '+session?.name+' 确认写入'} value={productionText} onChange={(_,d)=>setProductionText(d.value)} disabled={applying}/>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={applying}>
              {informativeOnly ? "关闭" : "取消"}
            </Button>
            {!informativeOnly && (
              <Button
                appearance="primary"
                onClick={() => void apply()}
                title={readOnly ? "只读会话不能执行写入" : undefined}
                disabled={readOnly || loading || applying || (production&&productionText!==session?.name) || (Boolean(warning) && !confirmed)}
              >
                {applying ? "执行中…" : "执行"}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
