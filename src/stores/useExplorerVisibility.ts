import { create } from 'zustand';
import { api } from '../ipc';

const KEY = 'explorer_hidden_views_v1';
export const visibilityKey = (sessionId: string, database: string) => JSON.stringify([sessionId, database]);
export const useExplorerVisibility = create<{ hiddenViews: Record<string, boolean>; busy: boolean }>(() => ({ hiddenViews: {}, busy: false }));
let loaded: Promise<void> | undefined;
let queue = Promise.resolve();

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
