import { useSessionStore } from "../../stores/useSessionStore";
import { useTabStore } from "../../stores/useTabStore";
import { updateDraft } from "../../stores/useWorkspace";
export async function openSql(sessionId: string, database: string, sql: string, path = "") {
  const sessions=useSessionStore.getState();
  if(!sessions.sessions.some(s=>s.id===sessionId))throw Error("原连接已删除，请先创建连接");
  if(!sessions.statuses[sessionId])await sessions.connect(sessionId);
  sessions.setActiveSession(sessionId);
  useTabStore.getState().openQuery(sessionId,database);
  const id=useTabStore.getState().activeId!;
  updateDraft(id,{sessionId,database,sql,updatedAt:new Date().toISOString(),filePath:path,fileBaseline:path?sql:undefined});
  window.dispatchEvent(new Event("dw:show-workspace"));
}
