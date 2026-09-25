import {useExplorerStore} from "./useExplorerStore";
import { connectionBridge } from "../ipc/connectionBridge";
import { rememberUndo } from "./useLocalUndo";
import { activeSessionTasks, errorText } from "./useTaskStore";
import { confirmEdits, useEditGuard } from "./useEditGuard";
import { create } from "zustand";
import { api } from "../ipc";
import type { ConnectionStatus, SessionInput, SessionRecord } from "../ipc/types";

const FOLDERS_KEY = "session_folders";

export interface ConnectionPhase { state: "connecting" | "connected" | "disconnected"; error?: string; lost?: boolean }
const connecting = new Map<string, Promise<void>>();
const mutating = new Set<string>();
const checking = new Set<string>();
const busySession = (id: string) => activeSessionTasks(id).length > 0 || Object.values(useEditGuard.getState().entries).some(e => e.sessionId === id && e.busy?.());

interface SessionState {
  phases: Record<string, ConnectionPhase>;
  checkHealth: (id: string) => Promise<void>;
  sessions: SessionRecord[];
  statuses: Record<string, ConnectionStatus>;
  folders: string[];
  loading: boolean;
  activeSessionId: string | null;
  setActiveSession: (id: string | null) => void;
  load: () => Promise<void>;
  loadFolders: () => Promise<void>;
  createFolder: (name: string) => Promise<void>;
  deleteFolder: (name: string) => Promise<void>;
  moveToGroup: (id: string, group: string | null) => Promise<void>;
  duplicateSession: (sourceId:string,input:SessionInput)=>Promise<SessionRecord>;
  createSession: (input: SessionInput) => Promise<SessionRecord>;
  updateSession: (id: string, input: SessionInput) => Promise<SessionRecord>;
  deleteSession: (id: string) => Promise<void>;
  connect: (id: string) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
}

function sortSessions(sessions: SessionRecord[]): SessionRecord[] {
  return [...sessions].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  statuses: {},
  phases: {},
  folders: [],
  loading: false,
  activeSessionId: null,

  setActiveSession: (id) => set({ activeSessionId: id }),

  load: async () => {
    const initialStatuses = get().statuses;
    set({ loading: true });
    try {
      const [sessions, statuses] = await Promise.all([
        api.listSessions(),
        api.sessionStatuses(),
      ]);
      set({
        sessions,
        loading: false,
        statuses: get().statuses === initialStatuses && connecting.size === 0 && mutating.size === 0 ? Object.fromEntries(statuses.map((s) => {
          const previous = initialStatuses[s.sessionId];
          return [s.sessionId, previous?.serverVersion === s.serverVersion && previous?.connected === s.connected ? previous : s];
        })) : get().statuses,
      });
    } catch (error) {
      set({ loading: false });
      throw error;
    }
  },

  loadFolders: async () => {
    try {
      const raw = await api.settingsGet(FOLDERS_KEY);
      const folders = raw ? (JSON.parse(raw) as string[]) : [];
      set({ folders: Array.isArray(folders) ? folders : [] });
    } catch {
      set({ folders: [] });
    }
  },

  createFolder: async (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const folders = get().folders.includes(trimmed)
      ? get().folders
      : [...get().folders, trimmed];
    await api.settingsSet(FOLDERS_KEY, JSON.stringify(folders));
    set({ folders });
  },

  deleteFolder: async (name) => {
    const folders = get().folders.filter((folder) => folder !== name);
    await api.settingsSet(FOLDERS_KEY, JSON.stringify(folders));
    const moved = get().sessions.filter((session) => session.groupName === name);
    for (const session of moved) {
      await api.sessionSetGroup(session.id, null);
    }
    set({
      folders,
      sessions: get().sessions.map((session) =>
        session.groupName === name ? { ...session, groupName: null } : session,
      ),
    });
  },

  moveToGroup: async (id, group) => {
    const previous = get().sessions.find(s => s.id === id)?.groupName ?? null;
    await api.sessionSetGroup(id, group);
    set({
      sessions: get().sessions.map((session) =>
        session.id === id ? { ...session, groupName: group } : session,
      ),
    });
    if (previous !== group) rememberUndo("移动会话分组", async () => {
      if (!get().sessions.some(s => s.id === id)) throw Error("该会话已被删除，无法恢复分组");
      if (previous && !get().folders.includes(previous)) throw Error("原分组已被删除，请先恢复分组后重试");
      await api.sessionSetGroup(id, previous);
      set({ sessions: get().sessions.map(s => s.id === id ? { ...s, groupName: previous } : s) });
    });
  },

  duplicateSession: async (sourceId,input) => {
    const record=await api.duplicateSession(sourceId,input);
    set({sessions:sortSessions([...get().sessions,record])});
    return record;
  },

  createSession: async (input) => {
    const record = await api.createSession(input);
    set({ sessions: sortSessions([...get().sessions, record]) });
    return record;
  },

  updateSession: async (id, input) => {
    if (connecting.has(id) || mutating.has(id) || busySession(id)) throw new Error("请等待该会话的任务结束后修改连接");
    if(!await confirmEdits(e=>e.sessionId===id))throw new Error("已取消修改会话");
    if (connecting.has(id) || mutating.has(id) || busySession(id)) throw new Error("请等待该会话的操作结束");
    mutating.add(id);
    try {
      const record = await api.updateSession(id, input);
      useExplorerStore.getState().clearSession(id);
      const statuses = { ...get().statuses };
      delete statuses[id];
      set({
        sessions: get().sessions.map((s) => (s.id === id ? record : s)),
        statuses,
        phases: { ...get().phases, [id]: { state: "disconnected" } },
      });
      return record;
    } finally { mutating.delete(id); }
  },

  deleteSession: async (id) => {
    if (connecting.has(id) || mutating.has(id) || busySession(id)) throw new Error("请等待该会话的任务结束后删除连接");
    mutating.add(id);
    try {
      await api.deleteSession(id);
      const statuses = { ...get().statuses };
      delete statuses[id];
      set({
        sessions: get().sessions.filter((s) => s.id !== id),
        statuses,
        phases: { ...get().phases, [id]: { state: "disconnected" } },
        activeSessionId: get().activeSessionId === id ? null : get().activeSessionId,
      });
    } finally { mutating.delete(id); }
  },

  checkHealth: async (id) => {
    const previous = get().statuses[id];
    if (!previous || checking.has(id) || connecting.has(id) || mutating.has(id) || busySession(id)) return;
    checking.add(id);
    try {
      await api.sessionHealth(id);
    } catch (error) {
      // 忽略重连/主动断开之前发出的探测结果。
      if (get().statuses[id] === previous && !connecting.has(id)) {
        const statuses = { ...get().statuses }; delete statuses[id];
        set({ statuses, phases: { ...get().phases, [id]: { state: "disconnected", lost: true, error: errorText(error) } } });
      }
    } finally { checking.delete(id); }
  },
  connect: (id) => {
    const pending = connecting.get(id); if (pending) return pending;
    if (mutating.has(id)) return Promise.reject(new Error("请等待该会话的操作结束"));
    if (get().statuses[id]) return Promise.resolve();
    if (busySession(id)) return Promise.reject(new Error("请等待该会话的任务结束后重新连接"));
    const operation = Promise.resolve().then(async () => {
      try {
        const status = await api.connectSession(id);
        set({ statuses: { ...get().statuses, [id]: status }, phases: { ...get().phases, [id]: { state: "connected" } } });
      } catch (error) {
        const statuses = { ...get().statuses }; delete statuses[id];
        set({ statuses, phases: { ...get().phases, [id]: { state: "disconnected", lost: get().phases[id]?.lost, error: errorText(error) } } });
        throw error;
      } finally { connecting.delete(id); }
    });
    connecting.set(id, operation);
    set({ phases: { ...get().phases, [id]: { ...get().phases[id], state: "connecting", error: undefined } } });
    return operation;
  },

  disconnect: async (id) => {
    if (connecting.has(id) || mutating.has(id) || busySession(id)) throw new Error("请等待连接或任务结束后断开");
    mutating.add(id);
    try {
      await api.disconnectSession(id);
      const statuses = { ...get().statuses };
      delete statuses[id];
      set({ statuses, phases: { ...get().phases, [id]: { state: "disconnected" } } });
    } finally { mutating.delete(id); }
  },
}));

connectionBridge.isOffline = id => { const state=useSessionStore.getState(); return !state.statuses[id] && !!state.phases[id]; };
connectionBridge.onFailure = ids => { for (const id of ids) void useSessionStore.getState().checkHealth(id); };
