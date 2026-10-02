import {InfoHint} from '../common/InfoHint';
import { useEffect, useRef, useState } from "react";
import { Button, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Input, Link, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, tokens } from "@fluentui/react-components";
import { DataBarVerticalRegular, AddRegular, AppFolderRegular, ArrowUndoRegular, ArrowResetRegular, FullScreenMaximizeRegular, InfoRegular, DeleteRegular, SaveRegular, DismissRegular, SettingsRegular, TabDesktopRegular, ChevronDownRegular } from "@fluentui/react-icons";
import { useFocusMode, toggleFocusMode } from "../stores/useFocusMode";
import { useLocalUndo, undoLocal } from "../stores/useLocalUndo";
import { applyLayout, BUILTIN_LAYOUTS, deleteLayoutPreset, loadLayoutPresets, saveLayoutPreset, useLayoutPresets } from "../stores/useLayoutPresets";
import { useSessionStore } from "../stores/useSessionStore";
import { useTabStore } from "../stores/useTabStore";
import { useNotify } from "./toast";
import { openUrl } from "@tauri-apps/plugin-opener";

export const APP_RELEASE = "1.0.0-alpha.8";
export function WorkbenchHub() {
  const notify = useNotify(), focus = useFocusMode(s => s.active), entries = useLocalUndo(s => s.entries), undoBusy = useLocalUndo(s => s.busy);
  const presets = useLayoutPresets(s => s.presets), closed = useTabStore(s => s.recentlyClosed);
  const [dialog, setDialog] = useState<"layout" | "about" | null>(null), [name, setName] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
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
    const about = () => { setError(""); setDialog("about"); };
    const key = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "j") { e.preventDefault(); toggleFocusMode(); }
      else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "t" && !document.querySelector('[role="dialog"]')) { e.preventDefault(); void reopen(); }
      else if (e.ctrlKey && e.altKey && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
    };
    const restore = () => void reopen();
    window.addEventListener("keydown", key, true); window.addEventListener("dw:layouts", layout); window.addEventListener("dw:about", about); window.addEventListener("dw:reopen-tab", restore);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("dw:layouts", layout); window.removeEventListener("dw:about", about); window.removeEventListener("dw:reopen-tab", restore); };
  }, [notify]);
  const emit = (event: string) => window.dispatchEvent(new Event(event));
  return <>
    {focus && <Button size="small" appearance="subtle" icon={<FullScreenMaximizeRegular />} onClick={toggleFocusMode} title="退出专注模式 (Ctrl+Shift+J)">退出专注</Button>}
    {entries.length > 0 && <Button size="small" appearance="subtle" icon={<ArrowUndoRegular />} aria-label={"撤销" + entries.slice(-1)[0]!.label} title={"撤销" + entries.slice(-1)[0]!.label + " (Ctrl+Alt+Z)"} disabled={undoBusy} onClick={undo} />}
    <Menu><MenuTrigger disableButtonEnhancement><Button size="small" appearance="subtle" icon={<AppFolderRegular />} title="工作区布局、页签恢复与关于" aria-label="工作区菜单" /></MenuTrigger><MenuPopover><MenuList>
      <MenuItem icon={<DataBarVerticalRegular />} onClick={() => emit("dw:analysis")}>数据分析与图表…</MenuItem>
      <MenuItem icon={<AddRegular />} onClick={() => emit("dw:generation")}>数据生成…</MenuItem>
      <MenuItem icon={<AppFolderRegular />} onClick={() => emit("dw:layouts")}>工作区布局…</MenuItem>
      <MenuItem icon={<FullScreenMaximizeRegular />} onClick={toggleFocusMode}>{focus ? "退出" : "进入"}专注模式 · Ctrl+Shift+J</MenuItem>
      <MenuItem icon={<ArrowResetRegular />} disabled={!closed.length} onClick={() => emit("dw:reopen-tab")}>重新打开关闭的页签 · Ctrl+Shift+T</MenuItem>
      <MenuItem icon={<ArrowUndoRegular />} disabled={!entries.length || undoBusy} onClick={undo}>撤销本地操作 · Ctrl+Alt+Z</MenuItem>
      <MenuItem icon={<SettingsRegular />} onClick={() => emit("dw:settings")}>首选项 · Ctrl+,</MenuItem>
      <MenuItem icon={<InfoRegular />} onClick={() => emit("dw:about")}>关于 DBFolio</MenuItem>
    </MenuList></MenuPopover></Menu>
    <Dialog open={dialog !== null} onOpenChange={(_, d) => { if (!d.open && !busy) setDialog(null); }}><DialogSurface style={{ width: dialog === "about" ? "min(420px,92vw)" : "min(640px,92vw)" }}><DialogBody>
      <DialogTitle>{dialog === "layout" ? "工作区布局" : "关于 DBFolio"}</DialogTitle>
      <DialogContent style={{ maxHeight: "65vh", overflowY: "auto" }}>
        {dialog === "layout" ? <>
          <InfoHint label="布局说明">保存面板位置、两侧宽度、上下比例与折叠状态。专注模式临时隐藏面板，不改写这些设置。</InfoHint>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{BUILTIN_LAYOUTS.map(p => <Button key={p.name} disabled={busy} icon={<AppFolderRegular />} onClick={() => void run(() => applyLayout(p.layout))}>{p.name}</Button>)}</div>
          <h3>我的布局 <small>（{presets.length}/12）</small></h3>
          {!presets.length && <p style={{ color: tokens.colorNeutralForeground3 }}>调整面板后，在下方保存当前布局。</p>}
          {presets.map(p => <div key={p.name} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}><Button disabled={busy} appearance="subtle" style={{ flex: 1, justifyContent: "start", minWidth: 0, overflowWrap: "anywhere" }} icon={<AppFolderRegular />} onClick={() => void run(() => applyLayout(p.layout))}>{p.name}</Button><Button disabled={busy} icon={<DeleteRegular />} aria-label={"删除布局 " + p.name} title="删除布局（可撤销）" onClick={() => void run(() => deleteLayoutPreset(p.name))} /></div>)}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}><Input style={{ flex: 1, minWidth: 0 }} aria-label="布局名称" placeholder="当前布局名称" maxLength={40} value={name} onChange={(_, d) => setName(d.value)} /><Button disabled={busy || !name.trim()} icon={<SaveRegular />} onClick={() => void run(async () => { await saveLayoutPreset(name); setName(""); })}>{busy ? "处理中…" : "保存当前布局"}</Button></div>
        </> : <>
          <dl style={{ display: "grid", gridTemplateColumns: "48px minmax(0, 1fr)", columnGap: 16, rowGap: 16, marginBlock: 16 }}>
            <dt style={{ color: tokens.colorNeutralForeground2 }}>作者</dt><dd style={{ margin: 0 }}>SerLiunx</dd>
            <dt style={{ color: tokens.colorNeutralForeground2 }}>邮箱</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>root@serliunx.com</dd>
            <dt style={{ color: tokens.colorNeutralForeground2 }}>主页</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}><Link href="https://www.serliunx.com" onClick={event => { event.preventDefault(); void openUrl("https://www.serliunx.com").catch(e => notify.error(e, "打开主页失败")); }}>https://www.serliunx.com</Link></dd>
          </dl>
        </>}
        {error && <p role="alert" style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</p>}
      </DialogContent><DialogActions><Button appearance="primary" disabled={busy} icon={<DismissRegular />} onClick={() => setDialog(null)}>关闭</Button></DialogActions>
    </DialogBody></DialogSurface></Dialog>
  </>;
}

export function TabOverflow({ tabs, activeId }: { tabs: ReturnType<typeof useTabStore.getState>["tabs"]; activeId: string | null }) {
  if (!tabs.length) return null;
  return <Menu><MenuTrigger disableButtonEnhancement><Button appearance="subtle" size="small" icon={<ChevronDownRegular />} title={"本会话页签（" + tabs.length + "）"} aria-label="本会话全部页签" /></MenuTrigger><MenuPopover><MenuList>{tabs.map(t => <MenuItem key={t.id} icon={<TabDesktopRegular />} onClick={() => useTabStore.getState().setActive(t.id)} title={t.database + " / " + t.title}>{t.id === activeId ? "✓ " : ""}{t.title} · {t.database}</MenuItem>)}</MenuList></MenuPopover></Menu>;
}
