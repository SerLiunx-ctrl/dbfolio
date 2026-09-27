import type { SqlExportDraft } from "../features/transfer/sqlExportModel";
import type {SyncDraft} from '../features/sync/model';
import type { AnalysisPlan } from "../features/analysis/model";
import type { Target } from "../features/generation/model";
import { confirmEdits, useEditGuard } from "./useEditGuard";
import { create } from "zustand";
import { api } from "../ipc";
import type { TableSelection } from "../ipc/types";

export interface QueryTab {
  id: string;
  kind: "query";
  sessionId: string;
  database: string;
  title: string;
}

export type TableView =
  | "data"
  | "structure"
  | "indexes"
  | "foreignKeys"
  | "ddl"
  | "info";

export interface TableTab {
  id: string;
  kind: "table";
  sessionId: string;
  database: string;
  schema?: string | null;
  table: string;
  view: TableView;
  title: string;
  pinned?: boolean;
}

export interface RedisTab {
  id: string;
  kind: "redis";
  sessionId: string;
  database: string;
  title: string;
}

export interface MongoTab { id:string; kind:"mongo"; sessionId:string; database:string; collection:string; title:string; }
export interface GenerationTab {id:string;kind:"generation";sessionId:string;database:string;title:string;target:Target;}
export interface AnalysisTab {id:string;kind:"analysis";sessionId:string;database:string;title:string;plan:AnalysisPlan;}
export interface SyncTab {id:string;kind:"sync";sessionId:"";database:"";title:string;draft?:SyncDraft}
export interface SqlExportTab {id:string;kind:"sqlExport";sessionId:"";database:"";title:string;draft?:Partial<SqlExportDraft>}
export interface MysqlToolTab {id:string;kind:'mysqlTool';sessionId:string;database:string;title:string;mode:'import'|'objects';table?:string}
export type WorkspaceTab = MysqlToolTab | SqlExportTab | SyncTab | AnalysisTab | QueryTab | TableTab | RedisTab | MongoTab | GenerationTab;

/** 置顶的表页签（按会话持久化，下次连接自动恢复） */
export interface PinnedTab {
  database: string;
  schema?: string | null;
  table: string;
}

export function tabKey(tab: {
  database: string;
  schema?: string | null;
  table: string;
}): string {
  return `${tab.database}\u0000${tab.schema ?? ""}\u0000${tab.table}`;
}

const pinnedSettingKey = (sessionId: string) => `pinned_tabs_${sessionId}`;

let counter = 0;
function nextId(prefix: string) {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

interface TabState {
  openMysqlTool:(sessionId:string,database:string,mode:'import'|'objects',table?:string)=>void;
  tabs: WorkspaceTab[];
  recentlyClosed: WorkspaceTab[];
  reopenClosed: (validSessionIds: string[], id?: string) => WorkspaceTab | null;
  closeRight: (id: string, order: string[]) => Promise<void>;
  activeId: string | null;
  pinned: Record<string, PinnedTab[]>;
  openSqlExport: (draft?:Partial<SqlExportDraft>)=>string;
  updateSqlExport:(id:string,draft:SqlExportDraft)=>void;
  openSync: ()=>string;
  updateSync:(id:string,draft:SyncDraft)=>void;
  openAnalysis: (plan:AnalysisPlan)=>string;
  updateAnalysis: (id:string,plan:AnalysisPlan)=>void;
  openGeneration: (target:Target)=>void;
  openMongo: (sessionId:string,database:string,collection:string)=>void;
  openQuery: (sessionId: string, database: string) => void;
  openTable: (selection: TableSelection, view?: TableView) => void;
  openRedis: (sessionId: string, database: string, title: string) => void;
  close: (id: string) => void;
  closeSession: (sessionId: string) => void;
  closeOthers: (id: string) => void;
  closeAllUnpinned: (sessionId: string) => void;
  trimToLimit: (maxTabs: number) => void;
  moveTab: (id: string, targetId: string, after: boolean) => void;
  setActive: (id: string | null) => void;
  loadPinned: (sessionId: string) => Promise<void>;
  togglePin: (id: string) => Promise<void>;
  restorePinned: (sessionId: string) => void;
}

export const useTabStore = create<TabState>((set, get) => ({
  openMysqlTool:(sessionId,database,mode,table)=>{const id=nextId('mysql-tool');set({tabs:[...get().tabs,{id,kind:'mysqlTool',sessionId,database,mode,table,title:mode==='import'?'SQL 导入':'数据库对象'+(database?' · '+database:'')}],activeId:id});window.dispatchEvent(new Event('dw:show-workspace'));},
  openSqlExport:(draft)=>{const id=nextId("sql-export");set({tabs:[...get().tabs,{id,kind:"sqlExport",sessionId:"",database:"",title:"SQL 导出",draft}],activeId:id});return id;},
  updateSqlExport:(id,draft)=>set({tabs:get().tabs.map(t=>t.id===id&&t.kind==="sqlExport"?{...t,draft,title:"SQL 导出"+(draft.database?" · "+draft.database:"")}:t)}),
  openSync:()=>{const id=nextId("sync");set({tabs:[...get().tabs,{id,kind:"sync",sessionId:"",database:"",title:"数据同步"}],activeId:id});return id;},
  updateSync:(id,draft)=>set({tabs:get().tabs.map(t=>t.id===id&&t.kind==="sync"?{...t,draft,title:"同步 · "+(draft.sourceDb||"源")+" → "+(draft.targetDb||"目标")}:t)}),

  openAnalysis: (plan)=>{const id=nextId("analysis");set({tabs:[...get().tabs,{id,kind:"analysis",sessionId:plan.sessionId,database:plan.database,title:"分析 · "+plan.name,plan}],activeId:id});return id;},
  updateAnalysis: (id,plan)=>set({tabs:get().tabs.map(t=>t.id===id&&t.kind==="analysis"?{...t,plan,database:plan.database,title:"分析 · "+plan.name}:t)}),
  openGeneration: (target)=>{const tab:GenerationTab={id:nextId("generation"),kind:"generation",sessionId:target.sessionId,database:target.database,title:"数据生成"+(target.object?" · "+target.object:""),target};set({tabs:[...get().tabs,tab],activeId:tab.id});},
  tabs: [],
  recentlyClosed: [],
  reopenClosed: (validSessionIds, id) => {
    const history = get().recentlyClosed.filter(t => (t.kind==="sync"||t.kind==="sqlExport") || validSessionIds.includes(t.sessionId));
    const tab = id ? history.find(t => t.id === id) : history.slice(-1)[0];
    if (!tab) { set({ recentlyClosed: history }); return null; }
    const existing = get().tabs.find(t => t.id === tab.id || (t.kind === tab.kind && t.sessionId === tab.sessionId && t.database === tab.database &&
      ((t.kind === "table" && tab.kind === "table" && tabKey(t) === tabKey(tab)) || (t.kind === "mongo" && tab.kind === "mongo" && t.collection === tab.collection) || t.kind === "redis")));
    const restored = existing ?? (tab.kind === "table" ? { ...tab, pinned: (get().pinned[tab.sessionId] ?? []).some(p => tabKey(p) === tabKey(tab)) } : tab);
    set({ tabs: existing ? get().tabs : [...get().tabs, restored], activeId: restored.id, recentlyClosed: history.filter(t=>t.id!==tab.id) });
    return restored;
  },
  closeRight: async (id, order) => {
    const at = order.indexOf(id), target = get().tabs.find(t => t.id === id);
    if (at < 0 || !target) return;
    const ids = get().tabs.filter(t => t.sessionId === target.sessionId && order.slice(at + 1).includes(t.id) && !(t.kind === "table" && t.pinned)).map(t => t.id);
    if (!await confirmEdits(e => ids.includes(e.tabId))) return;
    const removed = get().tabs.filter(t => ids.includes(t.id)), tabs = get().tabs.filter(t => !ids.includes(t.id));
    set({ tabs, recentlyClosed: [...get().recentlyClosed, ...removed].slice(-20), activeId: tabs.some(t => t.id === get().activeId) ? get().activeId : target.id });
  },
  activeId: null,
  pinned: {},

  openMongo: (sessionId,database,collection)=>{const old=get().tabs.find(t=>t.kind==="mongo"&&t.sessionId===sessionId&&t.database===database&&t.collection===collection);if(old){set({activeId:old.id});return;}const tab:MongoTab={id:nextId("mongo"),kind:"mongo",sessionId,database,collection,title:collection};set({tabs:[...get().tabs,tab],activeId:tab.id});},
  openQuery: (sessionId, database) => {
    const tab: QueryTab = {
      id: nextId("query"),
      kind: "query",
      sessionId,
      database,
      title: "查询",
    };
    set({ tabs: [...get().tabs, tab], activeId: tab.id });
  },

  openTable: (selection, view = "data") => {
    const existing = get().tabs.find(
      (tab) =>
        tab.kind === "table" &&
        tab.sessionId === selection.sessionId &&
        tab.database === selection.database &&
        tab.table === selection.table &&
        (tab.schema ?? null) === (selection.schema ?? null),
    );
    if (existing) {
      set({ activeId: existing.id });
      return;
    }
    const pinnedList = get().pinned[selection.sessionId] ?? [];
    const pinned = pinnedList.some(
      (item) =>
        item.database === selection.database &&
        (item.schema ?? null) === (selection.schema ?? null) &&
        item.table === selection.table,
    );
    const tab: TableTab = {
      id: nextId("table"),
      kind: "table",
      sessionId: selection.sessionId,
      database: selection.database,
      schema: selection.schema ?? null,
      table: selection.table,
      view,
      title: selection.table,
      pinned,
    };
    set({ tabs: [...get().tabs, tab], activeId: tab.id });
  },

  openRedis: (sessionId, database, title) => {
    const existing = get().tabs.find(
      (tab) =>
        tab.kind === "redis" &&
        tab.sessionId === sessionId &&
        tab.database === database,
    );
    if (existing) {
      set({ activeId: existing.id });
      return;
    }
    const tab: RedisTab = {
      id: nextId("redis"),
      kind: "redis",
      sessionId,
      database,
      title,
    };
    set({ tabs: [...get().tabs, tab], activeId: tab.id });
  },

  close: async (id) => {
    if (!await confirmEdits(e => e.tabId === id)) return;
    const recentlyClosed = [...get().recentlyClosed, ...get().tabs.filter(t => t.id === id)].slice(-20);
    const tabs = get().tabs.filter((tab) => tab.id !== id);
    let activeId = get().activeId;
    if (activeId === id) {
      activeId = tabs.length > 0 ? tabs[tabs.length - 1].id : null;
    }
    set({ tabs, activeId, recentlyClosed });
  },

  closeSession: async (sessionId) => {
    if (!await confirmEdits(e => e.sessionId === sessionId)) return;
    const tabs = get().tabs.filter((tab) => tab.sessionId !== sessionId);
    let activeId = get().activeId;
    if (activeId && !tabs.some((tab) => tab.id === activeId)) {
      activeId = tabs.length > 0 ? tabs[tabs.length - 1].id : null;
    }
    set({ tabs, activeId });
  },

  closeOthers: async (id) => {
    const selected=get().tabs.find(t=>t.id===id);
    if (!selected) return;
    const ids=get().tabs.filter(t=>t.id!==id && t.sessionId===selected?.sessionId && !(t.kind==="table"&&t.pinned)).map(t=>t.id);
    if (!await confirmEdits(e=>ids.includes(e.tabId))) return;
    const tabs = get().tabs.filter(tab => !ids.includes(tab.id));
    const activeId = get().activeId;
    set({
      tabs,
      recentlyClosed: [...get().recentlyClosed, ...get().tabs.filter(t => !tabs.some(v => v.id === t.id))].slice(-20),
      activeId: activeId && tabs.some((tab) => tab.id === activeId) ? activeId : (tabs.find(t=>t.id===id) ?? tabs[tabs.length-1])?.id ?? null,
    });
  },

  closeAllUnpinned: async (sessionId) => {
    const ids=get().tabs.filter(t=>t.sessionId===sessionId&&!(t.kind==="table"&&t.pinned)).map(t=>t.id);
    if (!await confirmEdits(e=>ids.includes(e.tabId))) return;
    const tabs = get().tabs.filter(tab => !ids.includes(tab.id));
    let activeId = get().activeId;
    if (activeId && !tabs.some((tab) => tab.id === activeId)) {
      activeId = tabs.length > 0 ? tabs[tabs.length - 1].id : null;
    }
    set({ tabs, activeId, recentlyClosed: [...get().recentlyClosed, ...get().tabs.filter(t => !tabs.some(v => v.id === t.id))].slice(-20) });
  },

  /** 超过数量上限时关闭最早打开的未置顶页签（按会话分别计数） */
  trimToLimit: (maxTabs) => {
    if (maxTabs <= 0) return;
    const all = get().tabs;
    const sessions = new Set<string>();
    for (const tab of all) sessions.add(tab.sessionId);

    const removed = new Set<string>();
    for (const sessionId of sessions) {
      const candidates = all.filter(
        (tab) =>
          tab.sessionId === sessionId &&
          !Object.values(useEditGuard.getState().entries).some(entry=>entry.tabId===tab.id) &&
          !(tab.kind === "table" && tab.pinned),
      );
      const overflow = candidates.length - maxTabs;
      for (let index = 0; index < overflow; index += 1) {
        removed.add(candidates[index].id);
      }
    }
    if (removed.size === 0) return;

    const activeBefore = all.find((tab) => tab.id === get().activeId);
    const tabs = all.filter((tab) => !removed.has(tab.id));
    let activeId = get().activeId;
    if (activeId && removed.has(activeId)) {
      const sameSession = tabs.filter(
        (tab) => tab.sessionId === activeBefore?.sessionId,
      );
      activeId =
        sameSession.length > 0
          ? sameSession[sameSession.length - 1].id
          : tabs.length > 0
            ? tabs[tabs.length - 1].id
            : null;
    }
    set({ tabs, activeId });
  },

  moveTab: (id, targetId, after) => {
    const tabs = [...get().tabs], from = tabs.findIndex(t => t.id === id);
    if (id === targetId || from < 0 || !tabs.some(t => t.id === targetId)) return;
    const [tab] = tabs.splice(from, 1);
    tabs.splice(tabs.findIndex(t => t.id === targetId) + (after ? 1 : 0), 0, tab);
    set({ tabs });
  },
  setActive: (id) => set({ activeId: id }),

  loadPinned: async (sessionId) => {
    try {
      const raw = await api.settingsGet(pinnedSettingKey(sessionId));
      const list = raw ? (JSON.parse(raw) as PinnedTab[]) : [];
      const valid = Array.isArray(list) ? list : [];
      set({ pinned: { ...get().pinned, [sessionId]: valid } });
      const keys = new Set(valid.map((item) => tabKey(item)));
      set({
        tabs: get().tabs.map((tab) =>
          tab.kind === "table" && tab.sessionId === sessionId
            ? { ...tab, pinned: keys.has(tabKey(tab)) }
            : tab,
        ),
      });
    } catch {
      set({ pinned: { ...get().pinned, [sessionId]: [] } });
    }
  },

  togglePin: async (id) => {
    const tab = get().tabs.find((item) => item.id === id);
    if (!tab || tab.kind !== "table") return;
    const sessionId = tab.sessionId;
    const list = get().pinned[sessionId] ?? [];
    const key = tabKey(tab);
    const exists = list.some((item) => tabKey(item) === key);
    const nextList = exists
      ? list.filter((item) => tabKey(item) !== key)
      : [...list, { database: tab.database, schema: tab.schema ?? null, table: tab.table }];
    set({
      pinned: { ...get().pinned, [sessionId]: nextList },
      tabs: get().tabs.map((item) =>
        item.id === id && item.kind === "table"
          ? { ...item, pinned: !exists }
          : item,
      ),
    });
    if (!exists) {
      const first = get().tabs.find(item => item.sessionId === sessionId && item.id !== id);
      if (first) get().moveTab(id, first.id, false);
    }
    await api.settingsSet(pinnedSettingKey(sessionId), JSON.stringify(nextList));
  },

  restorePinned: (sessionId) => {
    const list = get().pinned[sessionId] ?? [];
    for (const item of list) {
      get().openTable({
        sessionId,
        database: item.database,
        schema: item.schema ?? null,
        table: item.table,
      });
    }
  },
}));
