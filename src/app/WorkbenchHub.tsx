import {useShortcut,useShortcutLabel} from './shortcuts';
import {InfoHint} from '../common/InfoHint';
import { useEffect, useRef, useState } from "react";
import { Button, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Input, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, tokens } from "@fluentui/react-components";
import { DataBarVerticalRegular, AddRegular, AppFolderRegular, ArrowUndoRegular, ArrowResetRegular, FullScreenMaximizeRegular, InfoRegular, DeleteRegular, SaveRegular, DismissRegular, SettingsRegular, TabDesktopRegular, ChevronDownRegular } from "@fluentui/react-icons";
import { useFocusMode, toggleFocusMode } from "../stores/useFocusMode";
import { useLocalUndo, undoLocal } from "../stores/useLocalUndo";
import { applyLayout, BUILTIN_LAYOUTS, deleteLayoutPreset, loadLayoutPresets, saveLayoutPreset, useLayoutPresets } from "../stores/useLayoutPresets";
import { useSessionStore } from "../stores/useSessionStore";
import { useTabStore } from "../stores/useTabStore";
import { useNotify } from "./toast";
import { AboutDialog } from "../features/settings/AboutContent";

export { APP_RELEASE } from "./releaseInfo";
export function WorkbenchHub() {
  const notify = useNotify(), focus = useFocusMode(s => s.active), entries = useLocalUndo(s => s.entries), undoBusy = useLocalUndo(s => s.busy);
  const presets = useLayoutPresets(s => s.presets), closed = useTabStore(s => s.recentlyClosed);
  const [dialog, setDialog] = useState<"layout" | null>(null), [name, setName] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [aboutOpen, setAboutOpen] = useState(false);
  const reopening = useRef(false);
  const actionLock = useRef(false);
  const run = async (action: () => Promise<void>) => { if(actionLock.current)return;actionLock.current=true;setBusy(true); setError(""); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)); } finally { actionLock.current=false;setBusy(false); } };
  const undo = () => void undoLocal().catch(e => notify.error(e, "撤销失败，可重试"));
  useEffect(() => {
    const reopen = async () => {
      if (reopening.current) return;
      const sessions = useSessionStore.getState(), ids = sessions.sessions.map(s => s.id);
      const candidate = useTabStore.getState().recentlyClosed.filter(t => (t.kind==="sync"||t.kind==="sqlExport")||ids.includes(t.sessionId)).slice(-1)[0];
      if (!candidate) return;
      reopening.current = true;
      try {
        if (candidate.kind!=="sync"&&candidate.kind!=="sqlExport"&&!sessions.statuses[candidate.sessionId]) await sessions.connect(candidate.sessionId);
        const tab = useTabStore.getState().reopenClosed(ids,candidate.id);
        if (tab) { if(tab.kind!=="sync"&&tab.kind!=="sqlExport")sessions.setActiveSession(tab.sessionId); window.dispatchEvent(new Event("dw:show-workspace")); }
      } catch (e) { notify.error(e, "恢复页签失败"); } finally { reopening.current = false; }
    };
    const layout = () => { setError(""); setDialog("layout"); void loadLayoutPresets().catch(e => setError(String(e))); };
    const about = () => { setAboutOpen(true); };
    const restore = () => void reopen();
    window.addEventListener("dw:layouts", layout); window.addEventListener("dw:about", about); window.addEventListener("dw:reopen-tab", restore);
    return () => { window.removeEventListener("dw:layouts", layout); window.removeEventListener("dw:about", about); window.removeEventListener("dw:reopen-tab", restore); };
  }, [notify]);
  useShortcut('focus',()=>toggleFocusMode());
  useShortcut('reopen',()=>window.dispatchEvent(new Event('dw:reopen-tab')));
  useShortcut('undoLocal',()=>undo());
  const focusKey=useShortcutLabel('focus'),reopenKey=useShortcutLabel('reopen'),undoKey=useShortcutLabel('undoLocal'),settingsKey=useShortcutLabel('settings');
  const emit = (event: string) => window.dispatchEvent(new Event(event));
  return <>
    {focus && <Button size="small" appearance="subtle" icon={<FullScreenMaximizeRegular />} onClick={toggleFocusMode} title={`退出专注模式 (${focusKey})`}>退出专注</Button>}
    {entries.length > 0 && <Button size="small" appearance="subtle" icon={<ArrowUndoRegular />} aria-label={"撤销" + entries.slice(-1)[0]!.label} title={"撤销" + entries.slice(-1)[0]!.label + ` (${undoKey})`} disabled={undoBusy} onClick={undo} />}
    <Menu><MenuTrigger disableButtonEnhancement><Button size="small" appearance="subtle" icon={<AppFolderRegular />} title="工作区布局、页签恢复与关于" aria-label="工作区菜单" /></MenuTrigger><MenuPopover><MenuList>
      <MenuItem icon={<DataBarVerticalRegular />} onClick={() => emit("dw:analysis")}>数据分析与图表…</MenuItem>
      <MenuItem icon={<AddRegular />} onClick={() => emit("dw:generation")}>数据生成…</MenuItem>
      <MenuItem icon={<AppFolderRegular />} onClick={() => emit("dw:layouts")}>工作区布局…</MenuItem>
      <MenuItem icon={<FullScreenMaximizeRegular />} onClick={toggleFocusMode}>{focus ? "退出" : "进入"}专注模式 · {focusKey}</MenuItem>
      <MenuItem icon={<ArrowResetRegular />} disabled={!closed.length} onClick={() => emit("dw:reopen-tab")}>重新打开关闭的页签 · {reopenKey}</MenuItem>
      <MenuItem icon={<ArrowUndoRegular />} disabled={!entries.length || undoBusy} onClick={undo}>撤销本地操作 · {undoKey}</MenuItem>
      <MenuItem icon={<SettingsRegular />} onClick={() => emit("dw:settings")}>首选项 · {settingsKey}</MenuItem>
      <MenuItem icon={<InfoRegular />} onClick={() => emit("dw:about")}>关于 DBFolio</MenuItem>
    </MenuList></MenuPopover></Menu>
    <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    <Dialog open={dialog !== null} onOpenChange={(_, d) => { if (!d.open && !busy) setDialog(null); }}><DialogSurface style={{ width: "min(640px,92vw)" }}><DialogBody>
      <DialogTitle>工作区布局</DialogTitle>
      <DialogContent style={{ maxHeight: "65vh", overflowY: "auto" }}>
        <>
          <InfoHint label="布局说明">保存面板位置、两侧宽度、上下比例与折叠状态。专注模式临时隐藏面板，不改写这些设置。</InfoHint>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{BUILTIN_LAYOUTS.map(p => <Button key={p.name} disabled={busy} icon={<AppFolderRegular />} onClick={() => void run(() => applyLayout(p.layout))}>{p.name}</Button>)}</div>
          <h3>我的布局 <small>（{presets.length}/12）</small></h3>
          {!presets.length && <p style={{ color: tokens.colorNeutralForeground3 }}>调整面板后，在下方保存当前布局。</p>}
          {presets.map(p => <div key={p.name} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}><Button disabled={busy} appearance="subtle" style={{ flex: 1, justifyContent: "start", minWidth: 0, overflowWrap: "anywhere" }} icon={<AppFolderRegular />} onClick={() => void run(() => applyLayout(p.layout))}>{p.name}</Button><Button disabled={busy} icon={<DeleteRegular />} aria-label={"删除布局 " + p.name} title="删除布局（可撤销）" onClick={() => void run(() => deleteLayoutPreset(p.name))} /></div>)}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}><Input style={{ flex: 1, minWidth: 0 }} aria-label="布局名称" placeholder="当前布局名称" maxLength={40} value={name} onChange={(_, d) => setName(d.value)} /><Button disabled={busy || !name.trim()} icon={<SaveRegular />} onClick={() => void run(async () => { await saveLayoutPreset(name); setName(""); })}>{busy ? "处理中…" : "保存当前布局"}</Button></div>
        </>
        {error && <p role="alert" style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</p>}
      </DialogContent><DialogActions><Button appearance="primary" disabled={busy} icon={<DismissRegular />} onClick={() => setDialog(null)}>关闭</Button></DialogActions>
    </DialogBody></DialogSurface></Dialog>
  </>;
}

export function TabOverflow({ tabs, activeId }: { tabs: ReturnType<typeof useTabStore.getState>["tabs"]; activeId: string | null }) {
  if (!tabs.length) return null;
  return <Menu><MenuTrigger disableButtonEnhancement><Button appearance="subtle" size="small" icon={<ChevronDownRegular />} title={"本会话页签（" + tabs.length + "）"} aria-label="本会话全部页签" /></MenuTrigger><MenuPopover><MenuList>{tabs.map(t => <MenuItem key={t.id} icon={<TabDesktopRegular />} onClick={() => useTabStore.getState().setActive(t.id)} title={t.database + " / " + t.title}><span className="dw-tab-overflow-item"><strong>{t.id === activeId ? "✓ " : ""}{t.title}</strong><small>{t.database || "全局工具"}</small></span></MenuItem>)}</MenuList></MenuPopover></Menu>;
}
