import { useNotify } from "./toast";
import { Button, Spinner, tokens } from "@fluentui/react-components";
import { PlugConnectedRegular } from "@fluentui/react-icons";
import { useSessionStore } from "../stores/useSessionStore";
export function ConnectionNotice({ sessionId, standalone = false }: { sessionId: string; standalone?: boolean }) {
  const notify = useNotify();
  const status = useSessionStore(s => s.statuses[sessionId]);
  const phase = useSessionStore(s => s.phases[sessionId]);
  if (status) return null;
  const connecting = phase?.state === "connecting";
  const message = connecting ? "正在连接，请稍候…" : phase?.error ? (phase.lost ? "连接已断开，编辑内容已保留" : "连接失败") : standalone ? "该会话尚未连接" : "连接已断开，编辑内容已保留。重新连接后可继续操作。";
  return <div role="status" aria-live="polite" style={{ maxWidth: "100%", minWidth: 0, textAlign: standalone ? "center" : "left", flexDirection: standalone ? "column" : "row", display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, padding: "8px 12px", flexShrink: 0, background: standalone || connecting ? "transparent" : tokens.colorStatusWarningBackground1, color: tokens.colorNeutralForeground1 }}>
    {connecting && <Spinner size="tiny" />}
    <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{message}
      {phase?.error && <span style={{ display: "block", fontSize: 12 }}>{phase.error}</span>}
    </span>
    {!connecting && <Button size="small" icon={<PlugConnectedRegular />} onClick={() => void useSessionStore.getState().connect(sessionId).catch(error => notify.error(error, "重新连接失败"))}>{phase?.error ? "重试连接" : "连接"}</Button>}
  </div>;
}
