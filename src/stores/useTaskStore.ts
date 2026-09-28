import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export type TaskKind = "查询" | "修改" | "导入" | "导出" | "同步" | "生成" | "AI";
export type TaskStatus = "running" | "cancelling" | "success" | "error" | "cancelled";
export interface TaskProgress { processed: number; total: number | null; message: string; cancelRequested: boolean }
export interface WorkTask {
  id: string; kind: TaskKind; label: string; sessionIds: string[];
  startedAt: number; endedAt?: number; status: TaskStatus;
  tabId?: string;
  background?: boolean;
  progress?: TaskProgress; result?: string; error?: string; cancelError?: string;
}
export const isTaskActive = (task: WorkTask) => task.status === "running" || task.status === "cancelling";
// 前台查询仍注册任务以支持取消和连接保护，但不进入后台任务中心。
export const isBackgroundTask = (task: Pick<WorkTask, "kind" | "background">) =>
  task.background ?? !["查询", "修改"].includes(task.kind);
export const useTaskStore = create<{ tasks: WorkTask[] }>(() => ({ tasks: [] }));
export function updateTask(id: string, patch: Partial<WorkTask>) {
  useTaskStore.setState(s => ({ tasks: s.tasks.map(t => t.id === id ? { ...t, ...patch } : t) }));
}
export function activeSessionTasks(id: string) {
  return useTaskStore.getState().tasks.filter(t => isTaskActive(t) && t.sessionIds.includes(id));
}
export async function cancelTask(id: string) {
  const task = useTaskStore.getState().tasks.find(t => t.id === id);
  if (!task || !isTaskActive(task) || task.status === "cancelling") return;
  updateTask(id, { status: "cancelling", cancelError: undefined });
  try { await invoke("task_cancel", { id }); }
  catch (error) {
    const current = useTaskStore.getState().tasks.find(t => t.id === id);
    if (current && isTaskActive(current)) updateTask(id, { status: "running", cancelError: errorText(error) });
  }
}
export function errorText(error: unknown): string {
  return typeof error === "object" && error && "message" in error ? String(error.message) : String(error);
}
