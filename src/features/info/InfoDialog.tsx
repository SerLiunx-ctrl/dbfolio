import {
  Button,
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
import type { InfoEntry } from "../../ipc/types";

const useStyles = makeStyles({
  body: {
    maxHeight: "52vh",
    overflow: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    paddingRight: "4px",
  },
  section: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "8px",
    overflow: "hidden",
  },
  sectionTitle: {
    padding: "5px 10px",
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
    background:
      "linear-gradient(90deg, color-mix(in srgb, var(--dw-accent) 14%, transparent), color-mix(in srgb, var(--dw-accent) 4%, transparent) 70%, transparent)",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  entries: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
    gap: "0 16px",
    padding: "6px 10px 8px",
  },
  entry: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: "8px",
    alignItems: "baseline",
    fontSize: tokens.fontSizeBase200,
    lineHeight: "18px",
    borderBottom: `1px solid ${tokens.colorNeutralBackground3}`,
    padding: "1px 0",
  },
  key: {
    color: tokens.colorNeutralForeground3,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  value: {
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    fontSize: "11px",
    maxWidth: "200px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    userSelect: "text",
  },
});

interface Props {
  open: boolean;
  title: string;
  entries: InfoEntry[];
  loading?: boolean;
  onClose: () => void;
}

export function InfoDialog({ open, title, entries, loading = false, onClose }: Props) {
  const styles = useStyles();
  const sections = new Map<string, InfoEntry[]>();
  for (const entry of entries) {
    const list = sections.get(entry.section) ?? [];
    list.push(entry);
    sections.set(entry.section, list);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open) onClose();
      }}
    >
      <DialogSurface style={{ maxWidth: "720px" }}>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            {loading ? (
              <Spinner size="tiny" label="读取信息…" />
            ) : (
              <div className={styles.body}>
                {[...sections.entries()].map(([section, list]) => (
                  <div key={section} className={styles.section}>
                    <div className={styles.sectionTitle}>{section}</div>
                    <div className={styles.entries}>
                      {list.map((entry) => (
                        <div key={entry.key} className={styles.entry}>
                          <span className={styles.key} title={entry.key}>
                            {entry.key}
                          </span>
                          <span className={styles.value} title={entry.value}>
                            {entry.value}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                {entries.length === 0 && (
                  <div className={styles.key}>暂无可用信息</div>
                )}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              关闭
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
