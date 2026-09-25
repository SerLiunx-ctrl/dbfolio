import { create } from "zustand";
import { api } from "../ipc";
import type { DatabaseMeta, TableMeta, TableRef, TableSelection } from "../ipc/types";

const revisions = new Map<string,number>();
const databasesKey = (sessionId: string) => `db:${sessionId}`;
const tablesKey = (sessionId: string, database: string) =>
  `tables:${sessionId}:${database}`;

interface ExplorerState {
  selectedDatabase: {sessionId:string;database:string}|null;
  databases: Record<string, DatabaseMeta[]>;
  tables: Record<string, TableRef[]>;
  loading: Record<string, boolean>;
  selection: TableSelection | null;
  detail: TableMeta | null;
  detailLoading: boolean;
  loadDatabases: (sessionId: string) => Promise<void>;
  loadTables: (sessionId: string, database: string) => Promise<void>;
  selectTable: (selection: TableSelection) => Promise<void>;
  refreshDetail: () => Promise<void>;
  clearSession: (sessionId: string) => void;
}

export const useExplorerStore = create<ExplorerState>((set, get) => ({
  selectedDatabase: null,
  databases: {},
  tables: {},
  loading: {},
  selection: null,
  detail: null,
  detailLoading: false,

  loadDatabases: async (sessionId) => {
    const key = databasesKey(sessionId);
    const revision=revisions.get(sessionId)??0;
    if (get().loading[key]) return;
    set({ loading: { ...get().loading, [key]: true } });
    try {
      const databases = await api.listDatabases(sessionId);
      if((revisions.get(sessionId)??0)!==revision)return;
      set({
        databases: { ...get().databases, [sessionId]: databases },
        loading: { ...get().loading, [key]: false },
      });
    } catch (error) {
      set({ loading: { ...get().loading, [key]: false } });
      throw error;
    }
  },

  loadTables: async (sessionId, database) => {
    const key = tablesKey(sessionId, database);
    const revision=revisions.get(sessionId)??0;
    if (get().loading[key]) return;
    set({ loading: { ...get().loading, [key]: true } });
    try {
      const tables = await api.listTables(sessionId, database);
      if((revisions.get(sessionId)??0)!==revision)return;
      set({
        tables: { ...get().tables, [key]: tables },
        loading: { ...get().loading, [key]: false },
      });
    } catch (error) {
      set({ loading: { ...get().loading, [key]: false } });
      throw error;
    }
  },

  selectTable: async (selection) => {
    set({ selection, detail: null, detailLoading: true });
    try {
      const detail = await api.tableDetail(
        selection.sessionId,
        selection.database,
        selection.table,
        selection.schema,
      );
      const current = get().selection;
      if (
        current &&
        current.sessionId === selection.sessionId &&
        current.database === selection.database &&
        current.table === selection.table
      ) {
        set({ detail, detailLoading: false });
      }
    } catch (error) {
      set({ detailLoading: false });
      throw error;
    }
  },

  refreshDetail: async () => {
    const selection = get().selection;
    if (!selection) return;
    set({ detailLoading: true });
    try {
      const detail = await api.tableDetail(
        selection.sessionId,
        selection.database,
        selection.table,
        selection.schema,
      );
      set({ detail, detailLoading: false });
    } catch (error) {
      set({ detailLoading: false });
      throw error;
    }
  },

  clearSession: (sessionId) => {
    revisions.set(sessionId,(revisions.get(sessionId)??0)+1);
    const databases = { ...get().databases };
    delete databases[sessionId];
    const tables: Record<string, TableRef[]> = {};
    const prefix = `tables:${sessionId}:`;
    for (const [key, value] of Object.entries(get().tables)) {
      if (!key.startsWith(prefix)) tables[key] = value;
    }
    const loading=Object.fromEntries(Object.entries(get().loading).filter(([key])=>key!==databasesKey(sessionId)&&!key.startsWith(prefix)));
    set({ databases, tables, loading, ...(get().selectedDatabase?.sessionId===sessionId?{selectedDatabase:null}:{}), ...(get().selection?.sessionId===sessionId?{selection:null,detail:null,detailLoading:false}:{}) });
  },
}));

export { databasesKey, tablesKey };
