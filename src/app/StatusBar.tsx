import { WorkbenchHub } from "./WorkbenchHub";
import { ProductivityHub } from "./ProductivityHub";
import { TaskCenter } from "./TaskCenter";
import { Button, makeStyles, tokens } from "@fluentui/react-components";
import { CircleFilled, DataBarVerticalRegular } from "@fluentui/react-icons";
import { ENGINE_LABELS } from "../features/sessions/engine";
import { useSessionStore } from "../stores/useSessionStore";
import { useTabStore } from "../stores/useTabStore";
import { EnvironmentBadge } from "../features/sessions/EnvironmentBadge";

const useStyles = makeStyles({
  bar: {
    height: "28px",
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: "8px",
    overflowX: "auto",
    padding: "0 12px",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    background:
      "linear-gradient(90deg, color-mix(in srgb, var(--dw-accent) 6%, transparent), transparent 55%)",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

export function StatusBar() {
  const styles = useStyles();
  const sessions = useSessionStore((s) => s.sessions);
  const statuses = useSessionStore((s) => s.statuses);
  const activeTab = useTabStore((s) => s.tabs.find((tab) => tab.id === s.activeId));

  const connectedCount = Object.keys(statuses).length;
  const session =
    activeTab && "sessionId" in activeTab
      ? sessions.find((s) => s.id === activeTab.sessionId)
      : undefined;
  const status = session ? statuses[session.id] : undefined;

  return (
    <footer className={styles.bar}>
      <div className={styles.item}>
        <CircleFilled
          fontSize={8}
          style={{
            color: connectedCount > 0 ? "#6ccb5f" : tokens.colorNeutralForeground4,
          }}
        />
        {connectedCount > 0 ? `${connectedCount} 个连接` : "未连接"}
      </div>
      {session && (
        <div className={styles.item}>
          {session.name} · {ENGINE_LABELS[session.engine]}
          <EnvironmentBadge sessionId={session.id} />
          {status?.serverVersion ? ` · ${status.serverVersion}` : ""}
        </div>
      )}
      {activeTab && activeTab.kind !== "redis" && (
        <div className={styles.item}>
          {activeTab.database}
          {activeTab.kind === "table" && activeTab.schema
            ? `.${activeTab.schema}`
            : ""}
          {activeTab.kind === "table" ? `.${activeTab.table}` : ""}
        </div>
      )}
      <div style={{ flex: 1 }} />
      <WorkbenchHub /><Button size="small" appearance="subtle" icon={<DataBarVerticalRegular/>} style={{flexShrink:0}} title="新建独立分析或打开已保存方案，无需先执行查询" onClick={()=>window.dispatchEvent(new Event("dw:analysis"))}>数据分析</Button><ProductivityHub /><TaskCenter />
    </footer>
  );
}
