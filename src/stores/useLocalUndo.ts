import { create } from "zustand";

interface UndoEntry { label: string; run: () => Promise<void> }
/** 仅撤销本地偏好，不用于数据库写入；退出应用后清空。 */
export const useLocalUndo = create<{ entries: UndoEntry[]; busy: boolean }>(() => ({ entries: [], busy: false }));
export function rememberUndo(label: string, run: () => Promise<void>) {
  useLocalUndo.setState(s => ({ entries: [...s.entries, { label, run }].slice(-20) }));
}
export async function undoLocal() {
  const state = useLocalUndo.getState(), entry = state.entries.slice(-1)[0];
  if (!entry || state.busy) return;
  useLocalUndo.setState({ busy: true });
  try { await entry.run(); useLocalUndo.setState(s => ({ entries: s.entries.filter(e => e !== entry) })); }
  finally { useLocalUndo.setState({ busy: false }); }
}
