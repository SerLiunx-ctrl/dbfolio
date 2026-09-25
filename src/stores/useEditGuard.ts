import { create } from "zustand";
import { useLayoutEffect, useRef } from "react";
export interface PendingEdit {
  tabId: string; sessionId: string; label: string; kind?: "transaction";
  save: () => Promise<void>; discard: () => void | Promise<void>;
  preview?: () => Promise<string[]>;
  busy?: () => boolean;
}
interface GuardState {
  entries: Record<string, PendingEdit>;
  request: { entries: PendingEdit[]; resolve: (value: boolean) => void } | null;
}
export const useEditGuard = create<GuardState>(() => ({ entries: {}, request: null }));
export function usePendingEdit(entry: PendingEdit, dirty: boolean, registryKey = entry.tabId) {
  const latest = useRef(entry); latest.current = entry;
  useLayoutEffect(() => {
    if (!dirty) return;
    const proxy: PendingEdit = { ...entry, save: () => latest.current.save(), discard: () => latest.current.discard(), busy:()=>latest.current.busy?.() ?? false,
      preview: entry.preview ? () => latest.current.preview!() : undefined };
    useEditGuard.setState(s => ({entries: {...s.entries, [registryKey]: proxy}}));
    return () => useEditGuard.setState(s => { const entries={...s.entries}; delete entries[registryKey]; return {entries}; });
  }, [dirty, entry.tabId, entry.sessionId, entry.label, registryKey]);
}
export async function confirmEdits(predicate: (entry: PendingEdit) => boolean = () => true): Promise<boolean> {
  const state=useEditGuard.getState();
  if(state.request) return false;
  const entries=Object.values(state.entries).filter(predicate);
  if(entries.some(entry=>entry.busy?.())) return false;
  if(!entries.length) return true;
  return new Promise(resolve => useEditGuard.setState({request:{entries,resolve}}));
}
