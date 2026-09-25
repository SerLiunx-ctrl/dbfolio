import { useEffect, useState } from "react";
import { Button, ProgressBar } from "@fluentui/react-components";
import { StopRegular } from "@fluentui/react-icons";
import { cancelTask, isTaskActive, useTaskStore, type TaskKind } from "../stores/useTaskStore";

/** 弹窗内也能查看任务与取消，不必关闭弹窗去操作底栏。 */
export function TaskActivity({ kind, sessionId, tabId }: { kind: TaskKind; sessionId?: string;tabId?:string }) {
  const tasks = useTaskStore(s => s.tasks);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer=window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const task = tasks.find(t => t.kind === kind && (!tabId||t.tabId===tabId) && (!sessionId || t.sessionIds.includes(sessionId)));
  if (!task) return null;
  return <div role="status" style={{ margin: "8px 0", padding: 8, border: "1px solid var(--colorNeutralStroke2)", borderRadius: 6, overflowWrap: "anywhere" }}>
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ flex: 1 }}>{task.label} · {(Math.max(0, (task.endedAt ?? now) - task.startedAt)/1000).toFixed(1)} 秒</span>
      {isTaskActive(task) && <Button size="small" icon={<StopRegular />} disabled={task.status === "cancelling"} onClick={() => void cancelTask(task.id)}>{task.status === "cancelling" ? "等待当前操作停止" : "取消任务"}</Button>}
    </div>
    {isTaskActive(task) && <ProgressBar aria-label="任务进度" value={task.progress?.total ? Math.min(1, task.progress.processed / task.progress.total) : undefined} />}
    <div>{task.progress?.message}</div>
    <div>{task.result}</div>
    <div>{task.error}</div>
    {task.cancelError && <div>取消失败：{task.cancelError}</div>}
  </div>;
}
