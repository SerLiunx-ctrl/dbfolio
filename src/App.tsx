import { CreateTableWorkspace } from './features/table/CreateTableWorkspace';
import {useExplorerStore} from "./stores/useExplorerStore";
import {DatabaseOverview} from "./features/explorer/DatabaseOverview";
import {TabIndicator} from "./app/TabIndicator";
import {SqlExportWorkspace} from "./features/transfer/SqlExportWorkspace";
import {MysqlToolsWorkspace} from './features/mysql/MysqlToolsWorkspace';
import { AnalysisWorkspace, AnalysisLauncher } from "./features/analysis/AnalysisWorkspace";
import { GenerationWorkspace, GenerationLauncher } from "./features/generation/GenerationWorkspace";
import { TabOverflow } from "./app/WorkbenchHub";
import { GenerationTabActivity } from "./app/GenerationTabActivity";
import { flushLayoutPresets } from "./stores/useLayoutPresets";
import { useFocusMode } from "./stores/useFocusMode";
import { connectionBridge } from "./ipc/connectionBridge";
import { MongoWorkspace } from "./features/mongo/MongoWorkspace";
import { flushDockLayout } from "./stores/useDockStore";
import { DockLayout, DockTitle } from "./app/DockLayout";
import { useActiveTabScroll } from "./app/useActiveTabScroll";
import { isTaskActive, useTaskStore } from "./stores/useTaskStore";
import { ConnectionNotice } from "./app/ConnectionNotice";
import { initializeWorkspace, flushWorkspace } from "./stores/useWorkspace";
import { createCloseHandler } from "./app/closeWindow";
import { initializeWindowState, flushWindowState } from "./app/windowState";
import { loadObjectPreferences } from "./stores/useObjectPreferences";
import { EnvironmentBadge } from "./features/sessions/EnvironmentBadge";
import { UnsavedChangesDialog } from "./app/UnsavedChangesDialog";
import { confirmEdits } from "./stores/useEditGuard";
import {
  Button,
  FluentProvider,
  MenuItem,
  MenuList,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  DataBarVerticalRegular,
  ArrowLeftRegular,
  ArrowSyncRegular,
  ArrowExportRegular,
  ChevronLeftRegular,
  CodeRegular,
  DatabaseRegular,
  DismissRegular,
  DismissSquareRegular,
  DismissCircleRegular,
  PinOffRegular,
  PinRegular,
  TableRegular,
} from "@fluentui/react-icons";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { memo, useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { ContextMenuPortal, ContextMenuSurface } from "./app/ContextMenuPortal";
import { StatusBar } from "./app/StatusBar";
import { TitleBar } from "./app/TitleBar";
import { AppMenu } from "./app/AppMenu";
import { AppToaster, useNotify } from "./app/toast";
import { ExplorerPanel } from "./features/explorer/ExplorerPanel";
import { QueryWorkspace } from "./features/query/QueryWorkspace";
import { RedisWorkspace } from "./features/redis/RedisWorkspace";
import { SessionDialog } from "./features/sessions/SessionDialog";
import {SqliteFileDrop,type SqliteFileDraft} from './features/sessions/SqliteFileDrop';
import {useTabPointerSort} from './app/useTabPointerSort';
import { SessionList } from "./features/sessions/SessionList";
import { SettingsWorkspace } from "./features/settings/SettingsWorkspace";
import { SyncWorkspace } from "./features/sync/SyncWorkspace";
import { TableWorkspace } from "./features/table/TableWorkspace";
import type { SessionRecord } from "./ipc/types";
import { useSessionStore } from "./stores/useSessionStore";
import { useSettingsStore } from "./stores/useSettingsStore";
import { useTabStore } from "./stores/useTabStore";
import { type WorkspaceTab } from "./stores/useTabStore";
import { useAppTheme, useIsDark } from "./theme";

const useStyles = makeStyles({
  root: {
    height: "100%",
    display: "flex",
    flexDirection: "column",
    backgroundColor: "transparent",
  },
  body: {
    flex: 1,
    display: "flex",
    minHeight: 0,
  },
  sidebar: {
    width: "300px",
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    minHeight: 0,
    overflow: "hidden",
  },
  sidebarHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 4px 4px 10px",
    flexWrap: "wrap",
    flexShrink: 0,
    background:
      "var(--dw-sidebar-heading-bg, linear-gradient(90deg, color-mix(in srgb, var(--dw-accent) 10%, transparent), transparent 70%))",
  },
  sidebarTitle: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
  },
  sidebarStack: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  sidebarTop: {
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    flexGrow: 0,
    flexShrink: 0,
  },
  sidebarBottom: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  collapsedRail: {
    width: "22px",
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "none",
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    background: "transparent",
    color: tokens.colorNeutralForeground3,
    cursor: "pointer",
    padding: 0,
    transition: "background-color 140ms cubic-bezier(0.33, 0, 0.67, 1)",
    ":hover": { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  main: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    position: "relative",
    overflow: "hidden",
    backgroundColor: tokens.colorNeutralBackground1,
  },
  zoomArea: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    flexShrink: 0,
    transformOrigin: "top left",
  },
  tabStrip: {
    display: "flex",
    alignItems: "flex-start",
    gap: "2px",
    padding: "4px 8px 0",
    overflowX: "auto",
    flexShrink: 0,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    minHeight: "36px",
  },
  tabSessionLabel: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    padding: "8px 8px 0 4px",
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    marginRight: "4px",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  tab: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 4px 4px 10px",
    borderRadius: "6px 6px 0 0",
    cursor: "default",
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase300,
    whiteSpace: "nowrap",
    transition:
      "background-color 140ms cubic-bezier(0.33, 0, 0.67, 1), color 140ms cubic-bezier(0.33, 0, 0.67, 1)",
    ":hover": { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  tabActive: {
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightSemibold,
    boxShadow: `inset 0 -2px 0 0 ${tokens.colorBrandStroke1}`,
  },
  tabTitle: {
    maxWidth: "160px",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  tabDb: {
    fontSize: "10px",
    color: tokens.colorNeutralForeground4,
    maxWidth: "90px",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  tabClose: {
    minWidth: "20px",
    width: "20px",
    height: "20px",
    padding: 0,
  },
  settingsPage: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  settingsHeader: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 12px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    flexShrink: 0,
  },
  settingsTitle: {
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  tabPin: {
    color: tokens.colorBrandForeground1,
    flexShrink: 0,
  },
  contextOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 1198,
  },
  contextMenu: {
    position: "fixed",
    zIndex: 1199,
    minWidth: "180px",
    padding: "4px",
    borderRadius: "6px",
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow16,
  },
  workspace: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  welcome: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "10px",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase300,
  },
  welcomeIcon: {
    color: "var(--dw-accent)",
    opacity: 0.85,
    marginBottom: "4px",
  },
  welcomeTitle: {
    fontSize: "20px",
    fontWeight: 600,
    background:
      "linear-gradient(90deg, var(--dw-accent), color-mix(in srgb, var(--dw-accent) 35%, currentColor))",
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    color: "transparent",
  },
});

export default function App() {
  const { theme, dark } = useAppTheme();
  const interfaceStyle = useSettingsStore((s) => s.interfaceStyle);

  return (
    <FluentProvider
      theme={theme}
      data-style={interfaceStyle}
      data-color-mode={dark ? "dark" : "light"}
      style={{ height: "100%", backgroundColor: "transparent" }}
    >
      <ErrorBoundary>
        <AppShell />
      </ErrorBoundary>
      <AppToaster />
      <UnsavedChangesDialog />
      <div id="dw-overlay-root" />
    </FluentProvider>
  );
}

const WorkspaceContent = memo(function WorkspaceContent({tab,active}:{tab:WorkspaceTab;active:boolean}) {
  const session=useSessionStore(s=>s.sessions.find(v=>v.id===tab.sessionId));
  if(session?.allowedDatabases && tab.database && !session.allowedDatabases.includes(tab.database)) return <div role="alert" style={{padding:24}}>数据库「{tab.database}」不在本会话允许范围内。请在会话设置中调整数据库范围。</div>;
  if(tab.kind==="sqlExport")return <SqlExportWorkspace tab={tab}/>;
  if(tab.kind==="mysqlTool")return <MysqlToolsWorkspace tab={tab}/>;
  if(tab.kind==="sync")return <SyncWorkspace tab={tab} active={active}/>;
  return <><ConnectionNotice sessionId={tab.sessionId}/>{tab.kind === "createTable" ? <CreateTableWorkspace tab={tab}/> : tab.kind === "analysis" ? <AnalysisWorkspace tab={tab}/> : tab.kind === "generation" ? <GenerationWorkspace tab={tab}/> : tab.kind === "query" ? <QueryWorkspace tab={tab} active={active}/> : tab.kind === "mongo" ? <MongoWorkspace tab={tab}/> : tab.kind === "redis" ? <RedisWorkspace tab={tab}/> : <TableWorkspace tab={tab} active={active}/>}</>;
});
function VisitedWorkspace({tab,active}:{tab:WorkspaceTab;active:boolean}) {
  const visited=useRef(false);
  if(active)visited.current=true;
  return visited.current ? <WorkspaceContent tab={tab} active={active}/> : null;
}

function AppShell() {
  const styles = useStyles();
  const notify = useNotify();
  const load = useSessionStore((s) => s.load);
  const loadFolders = useSessionStore((s) => s.loadFolders);
  const folders = useSessionStore((s) => s.folders);
  const sessions = useSessionStore((s) => s.sessions);
  const statuses = useSessionStore((s) => s.statuses);
  // 恢复页签时延迟首次挂载；断开后保留已有工作区状态。
  const mountedSessions = useRef(new Set<string>());
  Object.keys(statuses).filter(id => statuses[id]).forEach(id => mountedSessions.current.add(id));
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const selectedDatabase=useExplorerStore(s=>s.selectedDatabase);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const loadSettings = useSettingsStore((s) => s.load);
  const themeMode = useSettingsStore((s) => s.themeMode);
  const resolvedAccent = useSettingsStore((s) => s.resolvedAccent);



  const maxTabs = useSettingsStore((s) => s.maxTabs);
  const zoom = useSettingsStore((s) => s.zoom);


  const setSidebarCollapsed = useSettingsStore((s) => s.setSidebarCollapsed);
  const dark = useIsDark();

  const tabs = useTabStore((s) => s.tabs);
  const activeId = useTabStore((s) => s.activeId);
  const moveTab = useTabStore(s => s.moveTab);
  const wrapTabs = useSettingsStore(s => s.wrapTabs);
  const tabSort=useTabPointerSort(moveTab);
  const tabDrop=tabSort.target;
  const setActiveTab = useTabStore((s) => s.setActive);
  const closeTab = useTabStore((s) => s.close);
  const closeOthers = useTabStore((s) => s.closeOthers);
  const closeAllUnpinned = useTabStore((s) => s.closeAllUnpinned);
  const togglePin = useTabStore((s) => s.togglePin);

  const [copyingSession,setCopyingSession]=useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sqliteFile,setSqliteFile]=useState<SqliteFileDraft|null>(null);
  const [editing, setEditing] = useState<SessionRecord | null>(null);
  const [defaultGroup, setDefaultGroup] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory,setSettingsCategory]=useState("appearance");

  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: string } | null>(
    null,
  );
  const [sessionToolbarTarget, setSessionToolbarTarget] = useState<HTMLDivElement | null>(null);
  const tabStripRef = useRef<HTMLDivElement>(null);
  const zoomAreaRef = useRef<HTMLDivElement>(null);

  const tabCountRef = useRef(0);

  useEffect(() => {
    let disposed=false; let stop: (()=>void)|undefined;
    load().then(()=>disposed ? ()=>{} : initializeWorkspace(e=>notify.error(e,"工作区保存/恢复失败"))).then(fn=>{if(disposed)fn();else stop=fn;}).catch((error)=>notify.error(error,"加载会话失败"));
    loadFolders().catch(() => {});
    void initializeWindowState(error=>notify.error(error,"恢复窗口位置失败"));
    void loadObjectPreferences().catch(error => notify.error(error, "加载环境与收藏失败"));
    loadSettings().catch(() => {});
    return ()=>{disposed=true;stop?.();};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let disposed=false; let unlisten: (()=>void)|undefined;
    const appWindow = getCurrentWindow();
    appWindow.onCloseRequested(createCloseHandler({
      confirm: async () => { if (useTaskStore.getState().tasks.some(isTaskActive)) { notify.error(new Error("请在查询页停止查询，或在任务中心取消后台任务，等待结束后再退出"), "仍有任务正在运行"); return false; } return confirmEdits(); },
      flush: async () => { await flushWorkspace(); await flushWindowState(); await flushLayoutPresets(); await flushDockLayout(); },
      destroy: () => appWindow.destroy(),
      onError: error => notify.error(error, "退出失败"),
    })).then(fn=>{if(disposed)fn();else unlisten=fn;}).catch(e=>notify.error(e));
    return ()=>{disposed=true;unlisten?.();};
  }, [notify]);

  useEffect(() => { const show=()=>{setSettingsOpen(false);}; window.addEventListener("dw:show-workspace",show);return()=>window.removeEventListener("dw:show-workspace",show); }, []);

  useEffect(() => {
    const show=(event:Event)=>{setSettingsCategory((event as CustomEvent<{category?:string}>).detail?.category??"appearance");setSettingsOpen(true);};
    window.addEventListener("dw:settings",show);
    connectionBridge.currentTab=()=>{const s=useTabStore.getState();return s.tabs.find(t=>t.id===s.activeId);};
    return()=>{window.removeEventListener("dw:settings",show);connectionBridge.currentTab=undefined;};
  },[]);

  // 强调色写入 CSS 变量，供标题栏 / 分隔条等自定义样式使用
  useEffect(() => {
    document.documentElement.style.setProperty("--dw-accent", resolvedAccent);
  }, [resolvedAccent]);

  // 窗口 Mica 背景跟随应用主题（避免暗色主题叠在亮色 Mica 上）
  useEffect(() => {
    const target = themeMode === "system" ? null : dark ? "dark" : "light";
    getCurrentWindow()
      .setTheme(target)
      .catch(() => {});
  }, [themeMode, dark]);

  // 快捷键：Ctrl+加减号缩放、Ctrl+0 复位、Ctrl+B 收起/展开侧栏
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.ctrlKey) return;
      const settings = useSettingsStore.getState();
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        void settings.setZoom(settings.zoom + 0.1);
      } else if (event.key === "-") {
        event.preventDefault();
        void settings.setZoom(settings.zoom - 0.1);
      } else if (event.key === "0") {
        event.preventDefault();
        void settings.setZoom(1);
      } else if (event.key === "b" || event.key === "B") {
        event.preventDefault();
        if(useFocusMode.getState().active)useFocusMode.setState({active:false});else void settings.setSidebarCollapsed(!settings.sidebarCollapsed);
      } else if (event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);

      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Ctrl+滚轮缩放右侧内容
  useEffect(() => {
    const element = zoomAreaRef.current;
    if (!element) return;
    const handler = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const settings = useSettingsStore.getState();
      void settings.setZoom(settings.zoom + (event.deltaY < 0 ? 0.1 : -0.1));
    };
    element.addEventListener("wheel", handler, { passive: false });
    return () => element.removeEventListener("wheel", handler);
  }, []);

  const sessionTabs = tabs.filter(
    (tab) =>
      (tab.kind==="sync"||tab.kind==="sqlExport") || (Boolean(activeSessionId) &&
      tab.sessionId === activeSessionId &&
      mountedSessions.current.has(activeSessionId!)),
  );

  const visibleTabs: WorkspaceTab[] = sessionTabs;

  useActiveTabScroll(tabStripRef,
    JSON.stringify([activeSessionId, activeId, zoom, wrapTabs, visibleTabs.map(tab => [tab.id, tab.title])]),
    settingsOpen);

  // 切换会话或连接状态变化时，自动激活可见页签
  useEffect(() => {
    const activeTab = tabs.find((tab) => tab.id === activeId);
    if(activeTab?.kind==="sync"||activeTab?.kind==="sqlExport")return;
    if (!activeSessionId || !mountedSessions.current.has(activeSessionId)) {
      if (activeId && activeTab) {
        setActiveTab(null);
      }
      return;
    }
    if(!activeId&&selectedDatabase?.sessionId===activeSessionId)return;
    const visible = tabs.filter((tab) => (tab.kind==="sync"||tab.kind==="sqlExport") || tab.sessionId === activeSessionId);
    if (activeId && visible.some((tab) => tab.id === activeId)) return;
    setActiveTab(visible.length > 0 ? visible[visible.length - 1].id : null);
  }, [activeSessionId, statuses, tabs, activeId, setActiveTab, selectedDatabase]);

  // 页签数量超过上限时关闭最早的未置顶页签
  useEffect(() => {
    useTabStore.getState().trimToLimit(maxTabs);
  }, [tabs, maxTabs]);

  // 从设置页打开新表/查询时自动返回工作区
  useEffect(() => {
    if (settingsOpen && tabs.length > tabCountRef.current) {
      setSettingsOpen(false);
    }
    tabCountRef.current = tabs.length;
  }, [tabs, settingsOpen]);

  const handleNew = (group?: string | null) => {
    setSqliteFile(null);
    setCopyingSession(false);
    setEditing(null);
    setDefaultGroup(group ?? null);
    setDialogOpen(true);
  };

  const handleEdit = (session: SessionRecord) => {
    setCopyingSession(false);
    setEditing(session);
    setDialogOpen(true);
  };

  const handleSaved = (session: SessionRecord) => {
    setActiveSession(session.id);
  };

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const menuTab = tabMenu ? tabs.find((tab) => tab.id === tabMenu.tabId) : undefined;
  const activeSessionConnected = activeSessionId
    ? Boolean(statuses[activeSessionId])
    : false;

  const isTabVisible = (tab: WorkspaceTab) =>
    (tab.kind==="sync"||tab.kind==="sqlExport") || (Boolean(activeSessionId) &&
    tab.sessionId === activeSessionId &&
    mountedSessions.current.has(tab.sessionId));



  return (
    <div className={styles.root}>
      <TitleBar><AppMenu onNewSession={() => handleNew()} onSync={() => { useTabStore.getState().openSync(); setSettingsOpen(false); }} onSettings={() => setSettingsOpen(true)} /></TitleBar>
      <DockLayout sessions={<>
              <div className={styles.sidebarHeader}>
                <DockTitle panel="sessions"><span className={styles.sidebarTitle}>会话</span></DockTitle>
                <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                  <div ref={setSessionToolbarTarget} style={{ display: "flex" }} />
                  <Tooltip content="收起侧栏 (Ctrl+B)" relationship="label">
                    <Button
                      appearance="subtle"
                      size="small"
                      icon={<ChevronLeftRegular />}
                      aria-label="收起侧栏"
                      onClick={() => void setSidebarCollapsed(true)}
                    />
                  </Tooltip>
                </div>
              </div>

        <SessionList onNew={handleNew} onEdit={handleEdit} onCopy={session=>{setEditing(session);setCopyingSession(true);setDialogOpen(true);}} toolbarTarget={sessionToolbarTarget} />
      </>} explorer={<ExplorerPanel />}>
        <main className={styles.main}>
          <div
            ref={zoomAreaRef}
            className={styles.zoomArea}
            style={{
              transform: `scale(${zoom})`,
              width: `${100 / zoom}%`,
              height: `${100 / zoom}%`,
            }}
          >
            {settingsOpen && (
              <div className={styles.settingsPage}>
                <div className={styles.settingsHeader}>
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={<ArrowLeftRegular />}
                    onClick={() => setSettingsOpen(false)}
                  >
                    返回
                  </Button>
                  <span className={styles.settingsTitle}>首选项</span>
                </div>
                <SettingsWorkspace initialCategory={settingsCategory}/>
              </div>
            )}
            <div style={{display:settingsOpen?"none":"flex",minWidth:0,alignItems:"center",flexShrink:0}}>
            <div
              ref={tabStripRef}
              role="tablist" aria-label="工作区页签"
              className={`${styles.tabStrip} dw-tab-strip`}
              style={{ flex:1,minWidth:0, flexWrap: wrapTabs ? "wrap" : "nowrap", overflowX: wrapTabs ? "hidden" : "auto" }}
            >
              {["sync","sqlExport"].includes(tabs.find(t=>t.id===activeId)?.kind??"")?<span className={styles.tabSessionLabel}>全局工具</span>:activeSession && (
                <span className={styles.tabSessionLabel}>{activeSession.name}<EnvironmentBadge sessionId={activeSession.id} /></span>
              )}
              {visibleTabs.map((tab) => (
                <div
                  key={tab.id}
                  data-sort-tab={tab.id}
                  onPointerDown={event=>tabSort.start(event,tab.id)}
                  style={{flexShrink: 0, maxWidth: "100%", boxShadow: tabDrop?.id === tab.id ? `inset ${tabDrop.after ? "-2" : "2"}px 0 ${tokens.colorBrandStroke1}` : undefined}}
                  data-active-tab={tab.id === activeId}
                  title={(tab.kind==="sync"||tab.kind==="sqlExport")?"全局 · "+tab.title:tab.database+" / "+tab.title}
                  role="tab" aria-selected={tab.id===activeId} tabIndex={0}
                  onKeyDown={event=>{if(event.target!==event.currentTarget)return;if(event.key==="Enter"||event.key===" "){event.preventDefault();setActiveTab(tab.id);}}}
                  className={mergeClasses(
                    styles.tab, "dw-workspace-tab",
                    tab.id === activeId && styles.tabActive,
                  )}
                  onClick={() => {if(!tabSort.consumeClick())setActiveTab(tab.id);}}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setTabMenu({ x: event.clientX, y: event.clientY, tabId: tab.id });
                  }}
                >
                {tab.kind === "sqlExport" ? (<ArrowExportRegular fontSize={14}/>) : tab.kind === "sync" ? (<ArrowSyncRegular fontSize={14}/>) : tab.kind === "query" ? (
                    <CodeRegular fontSize={14} />
                  ) : tab.kind === "redis" ? (
                    <DatabaseRegular fontSize={14} />
                  ) : tab.kind === "mongo" ? (<DatabaseRegular fontSize={14}/>) : tab.kind === "generation" ? (<GenerationTabActivity tabId={tab.id}/>) : tab.kind === "analysis" ? (<DataBarVerticalRegular fontSize={14}/>) : tab.kind === "table" && tab.pinned ? (
                    <PinRegular fontSize={12} className={styles.tabPin} />
                  ) : (
                    <TableRegular fontSize={14} />
                  )}
                  <span className={styles.tabTitle}>{tab.title}</span>
                  {tab.kind === "table" && (
                    <span className={styles.tabDb}>{tab.database}</span>
                  )}
                  <Button
                    appearance="subtle"
                    size="small"
                    className={styles.tabClose}
                    icon={<DismissRegular fontSize={12} />}
                    aria-label="关闭页签"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(tab.id);
                    }}
                  />
                </div>
              ))}
              <TabIndicator/>
            </div>
            <TabOverflow tabs={visibleTabs} activeId={activeId}/>
            </div>
            {!settingsOpen && !activeId && activeSessionConnected && selectedDatabase?.sessionId===activeSessionId && <DatabaseOverview sessionId={selectedDatabase.sessionId} database={selectedDatabase.database}/>}
            {!settingsOpen && visibleTabs.length === 0 && !(activeSessionConnected && selectedDatabase?.sessionId===activeSessionId) && (
              <div className={styles.welcome}>
                {activeSession && !activeSessionConnected ? (
                  <>
                    <div className={styles.welcomeTitle}>{activeSession.name}</div>
                    <ConnectionNotice sessionId={activeSession.id} standalone />
                  </>
                ) : (
                  <>
                    <DatabaseRegular fontSize={44} className={styles.welcomeIcon} />
                    <div className={styles.welcomeTitle}>DBFolio</div>
                    <div>双击左侧会话连接，展开数据库并双击数据表开始浏览</div>
                    <div>或在数据库右键菜单中选择「新建查询」</div>
                    <Button icon={<DataBarVerticalRegular/>} onClick={()=>window.dispatchEvent(new Event("dw:analysis"))}>数据分析：新建 / 打开方案</Button>
                  </>
                )}
              </div>
            )}
            {tabs.filter(tab => (tab.kind==="sync"||tab.kind==="sqlExport") || mountedSessions.current.has(tab.sessionId)).map((tab) => (
              <div
                key={tab.id}
                className={`${styles.workspace} dw-workspace-content`}
                style={{
                  display:
                    !settingsOpen && tab.id === activeId && isTabVisible(tab)
                      ? "flex"
                      : "none",
                }}
              >
                <VisitedWorkspace tab={tab} active={!settingsOpen && tab.id===activeId && isTabVisible(tab)}/>
              </div>
            ))}
          </div>
        </main>
      </DockLayout>
      <AnalysisLauncher/><GenerationLauncher/><StatusBar />
      {tabMenu && menuTab && (
        <ContextMenuPortal>
          <div className={styles.contextOverlay} onClick={() => setTabMenu(null)} />
          <ContextMenuSurface
            className={`${styles.contextMenu} dw-context-menu`} x={tabMenu.x} y={tabMenu.y}>
            <MenuList>
              {menuTab.kind === "table" && (
                <MenuItem
                  icon={menuTab.pinned ? <PinOffRegular /> : <PinRegular />}
                  onClick={() => {
                    void togglePin(menuTab.id);
                    setTabMenu(null);
                  }}
                >
                  {menuTab.pinned ? "取消置顶" : "置顶"}
                </MenuItem>
              )}
              <MenuItem
                icon={<DismissRegular />}
                onClick={() => {
                  closeTab(menuTab.id);
                  setTabMenu(null);
                }}
              >
                关闭
              </MenuItem>
              <MenuItem icon={<DismissSquareRegular />}
                onClick={() => {
                  closeOthers(menuTab.id);
                  setTabMenu(null);
                }}
              >
                关闭其它
              </MenuItem>
              <MenuItem icon={<DismissSquareRegular />} onClick={()=>{void useTabStore.getState().closeRight(menuTab.id,visibleTabs.map(t=>t.id));setTabMenu(null);}}>关闭右侧（置顶除外）</MenuItem>
              <MenuItem icon={<DismissCircleRegular />}
                onClick={() => {
                  closeAllUnpinned(activeSessionId ?? "__none__");
                  setTabMenu(null);
                }}
              >
                关闭所有（置顶除外）
              </MenuItem>
            </MenuList>
          </ContextMenuSurface>
        </ContextMenuPortal>
      )}
      <SessionDialog
        sqliteFile={sqliteFile}
        open={dialogOpen}
        session={editing}
        copy={copyingSession}
        folders={folders}
        defaultGroup={defaultGroup}
        onClose={() => {setDialogOpen(false);setSqliteFile(null);}}
        onSaved={handleSaved}
      />
      <SqliteFileDrop contextKey={`${dialogOpen}:${editing?.id??''}:${copyingSession}:${settingsOpen}`} onFile={file=>{
        if(!dialogOpen){setEditing(null);setCopyingSession(false);setDefaultGroup(null);}
        setSqliteFile(file);setDialogOpen(true);
      }}/>
    </div>
  );
}
