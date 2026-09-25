import {useSessionStore} from "../stores/useSessionStore";
import { Button, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuDivider, makeStyles, tokens } from "@fluentui/react-components";
import { AddRegular, ArrowSyncRegular, SettingsRegular, AppFolderRegular, FullScreenMaximizeRegular, InfoRegular, ArrowResetRegular, PanelLeftRegular, ArrowExportRegular } from "@fluentui/react-icons";
import { toggleFocusMode, useFocusMode } from "../stores/useFocusMode";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useTabStore } from "../stores/useTabStore";

const useStyles = makeStyles({
  menu: { display: "flex", alignItems: "center", gap: "2px", paddingInline: "16px", flexShrink: 0 },
  trigger: { minWidth: "44px", height: "28px", paddingInline: "10px", fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightRegular },
});

export function AppMenu({ onNewSession, onSync, onSettings }: { onNewSession: () => void; onSync: () => void; onSettings: () => void }) {
  const styles = useStyles();
  const focus = useFocusMode(s => s.active);
  const collapsed = useSettingsStore(s => s.sidebarCollapsed);
  const hasClosedTabs = useTabStore(s => s.recentlyClosed.length > 0);
  const emit = (name: string) => window.dispatchEvent(new Event(name));
  return <nav className={styles.menu} aria-label="应用菜单">
    <Menu><MenuTrigger disableButtonEnhancement><Button appearance="subtle" className={styles.trigger}>文件</Button></MenuTrigger>
      <MenuPopover><MenuList>
        <MenuItem icon={<AddRegular />} onClick={onNewSession}>新建连接…</MenuItem>
        <MenuItem icon={<ArrowExportRegular />} onClick={() => {
          const state=useSessionStore.getState();const tabs=useTabStore.getState();const active=tabs.tabs.find(t=>t.id===tabs.activeId);const session=state.sessions.find(s=>s.id===state.activeSessionId);
          tabs.openSqlExport(session?.engine==='mysql'?{sessionId:session.id,database:active?.sessionId===session.id?active.database:session.database??'',tables:active?.kind==='table'?[active.table]:[]}:{});
          emit('dw:show-workspace');
        }}>导出 SQL 文件…</MenuItem>
        <MenuDivider />
        <MenuItem icon={<SettingsRegular />} secondaryContent="Ctrl+," onClick={onSettings}>首选项</MenuItem>
      </MenuList></MenuPopover>
    </Menu>
    <Menu><MenuTrigger disableButtonEnhancement><Button appearance="subtle" className={styles.trigger}>视图</Button></MenuTrigger>
      <MenuPopover><MenuList>
        <MenuItem icon={<PanelLeftRegular />} secondaryContent="Ctrl+B" onClick={() => { if (focus) useFocusMode.setState({ active: false }); else void useSettingsStore.getState().setSidebarCollapsed(!collapsed); }}>{collapsed || focus ? "显示" : "收起"}会话栏</MenuItem>
        <MenuItem icon={<FullScreenMaximizeRegular />} secondaryContent="Ctrl+Shift+J" onClick={toggleFocusMode}>{focus ? "退出" : "进入"}专注模式</MenuItem>
        <MenuItem icon={<AppFolderRegular />} onClick={() => emit("dw:layouts")}>工作区布局…</MenuItem>
        <MenuDivider />
        <MenuItem icon={<ArrowResetRegular />} secondaryContent="Ctrl+Shift+T" disabled={!hasClosedTabs} onClick={() => emit("dw:reopen-tab")}>重新打开关闭的页签</MenuItem>
      </MenuList></MenuPopover>
    </Menu>
    <Menu><MenuTrigger disableButtonEnhancement><Button appearance="subtle" className={styles.trigger}>工具</Button></MenuTrigger>
      <MenuPopover><MenuList>
        <MenuItem icon={<ArrowSyncRegular />} onClick={onSync}>数据同步…</MenuItem>
      </MenuList></MenuPopover>
    </Menu>
    <Menu><MenuTrigger disableButtonEnhancement><Button appearance="subtle" className={styles.trigger}>帮助</Button></MenuTrigger>
      <MenuPopover><MenuList>
        <MenuItem icon={<InfoRegular />} onClick={() => emit("dw:about")}>关于 DBFolio</MenuItem>
      </MenuList></MenuPopover>
    </Menu>
  </nav>;
}
