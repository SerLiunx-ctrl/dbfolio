import { invoke } from "@tauri-apps/api/core";
import { connectionBridge } from "./connectionBridge";
import { errorText, updateTask, useTaskStore, isTaskActive, type TaskKind, type TaskProgress } from "../stores/useTaskStore";

const commands: Record<string, [TaskKind, string]> = {
  export_sql: ["导出", "导出 SQL 文件"],
  transaction_execute: ["查询", "事务内执行 SQL"],
  query_ai: ["AI", "智能生成"],
  analysis_query: ["查询", "分析查询"],
  generation_generate:["生成","生成测试数据"],generation_write:["修改","写入生成数据"],generation_export:["导出","导出生成数据"],generation_suggest:["AI","AI 配置生成规则"],ai_models:["AI","获取模型列表"],ai_test:["AI","测试 AI 服务"],
  mongo_inspect:["查询","MongoDB 集合分析"], mongo_create_index:["修改","MongoDB 创建索引"], mongo_transfer:["导出","MongoDB 文件传输"],
  mongo_find:["查询","MongoDB 查询"], mongo_next:["查询","MongoDB 下一批"], mongo_write:["修改","MongoDB 文档修改"],
  query_execute: ["查询", "执行 SQL"], query_fetch_page: ["查询", "读取数据页"], query_explain: ["查询", "执行计划"],
  import_csv: ["导入", "CSV 导入"], export_data: ["导出", "导出数据"],
  sync_compare_schema: ["同步", "比较表结构"], sync_preview_schema: ["同步", "生成结构脚本"],
  sync_execute_schema: ["同步", "同步表结构"], sync_compare_data: ["同步", "比较表数据"], sync_execute_data: ["同步", "同步表数据"],
};
function describeResult(value: unknown): { result?: string; error?: string } {
  if (!value || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  const errors: string[] = [];
  if (v.error) errors.push(String(v.error));
  if (Array.isArray(v.tables)) for (const table of v.tables) if (table.error) errors.push(`${table.table}: ${table.error}`);
  let result = "操作完成";
  if (typeof v.uncertain === "number") result = `已提交 ${v.inserted}，失败 ${v.failed}，待核对 ${v.uncertain}，未尝试 ${v.unattempted}${v.cancelled ? " · 已停止" : ""}`;
  else if (typeof v.count === "number" && typeof v.id === "string" && typeof v.bytes === "number") result = `已生成 ${v.count} 条，尚未写入`;
  else if (typeof v.inserted === "number") result = `已提交 ${v.inserted} 行，跳过 ${v.skipped ?? 0} 行`;
  else if (typeof v.rows === "number") result = `已导出 ${v.rows} 行 · ${v.path}`;
  else if (Array.isArray(v.rows)) result = v.affected == null ? `返回 ${v.rows.length} 行` : `影响 ${v.affected} 行`;
  else if (typeof v.executed === "number") result = `已执行 ${v.executed} 条，失败 ${v.failed} 条`;
  else if (v.backupDirectory) result = `回滚材料：${v.backupDirectory}`;
  return { result, error: errors.length ? errors.join("\n") : undefined };
}
export async function trackedInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const request = (args?.request ?? args ?? {}) as Record<string, unknown>;
  const source = request.source as { sessionId?: string } | undefined;
  const target = (request.target ?? (request.plan as {target?:unknown}|undefined)?.target) as { sessionId?: string } | undefined;
  const sessionIds = [...new Set([request.sessionId, args?.sessionId, source?.sessionId, target?.sessionId].filter((id): id is string => typeof id === "string"))];
  const networkOperation = command !== "generation_export" && !command.startsWith("session_") && !command.startsWith("query_history") && command !== "query_cancel" && command !== "transaction_finish";
  if (networkOperation && sessionIds.some(id => connectionBridge.isOffline?.(id))) {
    throw { code: "E_CONN", message: "连接已断开，编辑内容已保留。请重新连接后再操作。" };
  }
  const spec = command === "mongo_transfer" ? [request.direction === "import" ? "导入" : "导出", "MongoDB " + (request.direction === "import" ? "导入" : "导出")] as [TaskKind,string] : commands[command];
  if (!spec) {
    try { return await invoke<T>(command, args); }
    catch (error) { if (networkOperation) connectionBridge.onFailure?.(sessionIds); throw error; }
  }
  const id = crypto.randomUUID();
  const tab = connectionBridge.currentTab?.();
  const originTabId=args?.originTabId as string|undefined;
  const tabId = (spec[0]==="同步" || command==="query_ai" || command==="export_sql") ? originTabId : tab && sessionIds.includes(tab.sessionId) && (!request.database || request.database === tab.database) ? tab.id : undefined;
  const queryLabel = spec[0] === "查询" && typeof request.sql === "string" ? " · " + request.sql.replace(/\s+/g, " ").trim().slice(0, 100) : "";
  await invoke("task_begin", { id });
  useTaskStore.setState(s => ({ tasks: [{ id, tabId, kind: spec[0], label: `${spec[1]}${request.table ? ` · ${request.table}` : request.database ? ` · ${request.database}` : ""}` + queryLabel, sessionIds, startedAt: Date.now(), status: "running" }, ...s.tasks.filter(isTaskActive), ...s.tasks.filter(t => !isTaskActive(t)).slice(0, 99)] }));
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try { const progress = await invoke<TaskProgress | null>("task_progress", { id }); if (progress && useTaskStore.getState().tasks.some(t => t.id === id && isTaskActive(t))) updateTask(id, { progress }); }
    catch { /* 原操作的结果仍由调用返回，轮询失败不伪装成操作失败。 */ }
    finally { polling = false; }
  };
  const timer = window.setInterval(() => void poll(), 500);
  try {
    const value = await invoke<T>(command, { ...args, taskId: id });
    const summary = describeResult(value);
    updateTask(id, { ...summary, status: summary.error ? "error" : (value as {cancelled?:boolean})?.cancelled ? "cancelled" : "success", endedAt: Date.now() });
    return value;
  } catch (error) {
    const code = (error as { code?: string })?.code;
    updateTask(id, { status: code === "E_CANCELLED" ? "cancelled" : "error", error: errorText(error), endedAt: Date.now() });
    if (code !== "E_CANCELLED" && code !== "E_DANGEROUS") connectionBridge.onFailure?.(sessionIds);
    throw error;
  } finally {
    window.clearInterval(timer);
    // 最后一次读取保留已提交数量与回滚目录，即使操作被取消或失败。
    try { const progress = await invoke<TaskProgress | null>("task_progress", { id }); if (progress) updateTask(id, { progress }); } catch { /* 保留最后一次成功的进度 */ }
    await invoke("task_release", { id }).catch(() => undefined);
  }
}
