import { create } from 'zustand';
import { api } from '../ipc';

const KEY = 'explorer_hidden_views_v1';
const HIDDEN_DATABASES_KEY = 'explorer_hidden_databases_v1';

interface ExplorerVisibility {
  hiddenViews: Record<string, boolean>;
  hiddenDatabases: Record<string, readonly string[]>;
  busy: boolean;
}

export const visibilityKey = (sessionId: string, database: string) => JSON.stringify([sessionId, database]);
export const useExplorerVisibility = create<ExplorerVisibility>(() => ({
  hiddenViews: {},
  hiddenDatabases: {},
  busy: false,
}));

let loaded: Promise<void> | undefined;
let queue = Promise.resolve();
let databasesLoaded: Promise<void> | undefined;
let databasesQueue = Promise.resolve();

export function loadExplorerVisibility() {
  if (!loaded) loaded = (async () => {
    const raw = await api.settingsGet(KEY);
    if (!raw) return;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('对象树视图显隐设置格式无效');
    const entries = Object.entries(value).filter(([key, hidden]) => {
      try { const parts = JSON.parse(key); return hidden === true && Array.isArray(parts) && parts.length === 2 && parts.every(v => typeof v === 'string'); }
      catch { return false; }
    });
    useExplorerVisibility.setState({ hiddenViews: Object.fromEntries(entries) });
  })().catch(error => { loaded = undefined; throw error; });
  return loaded;
}

export function toggleExplorerViews(sessionId: string, database: string) {
  const job = queue.catch(() => {}).then(async () => {
    useExplorerVisibility.setState({ busy: true });
    try {
      await loadExplorerVisibility();
      const key = visibilityKey(sessionId, database), next = { ...useExplorerVisibility.getState().hiddenViews };
      if (next[key]) delete next[key]; else next[key] = true;
      await api.settingsSet(KEY, JSON.stringify(next));
      useExplorerVisibility.setState({ hiddenViews: next });
    } finally { useExplorerVisibility.setState({ busy: false }); }
  });
  queue = job;
  return job;
}

function normalizeDatabaseNames(names: readonly unknown[]): string[] {
  return [...new Set(names.filter((name): name is string => typeof name === 'string' && name.length > 0))].sort();
}

export function loadExplorerDatabaseVisibility(): Promise<void> {
  if (!databasesLoaded) databasesLoaded = (async () => {
    const raw = await api.settingsGet(HIDDEN_DATABASES_KEY);
    if (!raw) return;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw Error('数据库显隐设置格式无效');
    }
    const entries: [string, string[]][] = [];
    for (const [sessionId, names] of Object.entries(value)) {
      if (!Array.isArray(names)) continue;
      const hiddenNames = normalizeDatabaseNames(names);
      if (hiddenNames.length > 0) entries.push([sessionId, hiddenNames]);
    }
    useExplorerVisibility.setState({ hiddenDatabases: Object.fromEntries(entries) });
  })().catch(error => {
    databasesLoaded = undefined;
    throw error;
  });
  return databasesLoaded;
}

export function setExplorerHiddenDatabases(sessionId: string, names: readonly string[]): Promise<void> {
  const hiddenNames = normalizeDatabaseNames(names);
  const job = databasesQueue.catch(() => {}).then(async () => {
    await loadExplorerDatabaseVisibility();
    const { hiddenDatabases } = useExplorerVisibility.getState();
    const previous = hiddenDatabases[sessionId] ?? [];
    if (previous.length === hiddenNames.length && previous.every((name, index) => name === hiddenNames[index])) return;

    const next = { ...hiddenDatabases };
    if (hiddenNames.length > 0) next[sessionId] = hiddenNames;
    else delete next[sessionId];
    await api.settingsSet(HIDDEN_DATABASES_KEY, JSON.stringify(next));
    useExplorerVisibility.setState({ hiddenDatabases: next });
  });
  databasesQueue = job;
  return job;
}
