import { createPortal } from "react-dom";
import { confirmEdits } from "../../stores/useEditGuard";
import { EnvironmentBadge } from "./EnvironmentBadge";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Spinner,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  AddRegular,
  ArrowClockwiseRegular,
  ChevronRightRegular,
  DeleteRegular,
  EditRegular,
  CopyRegular,
  FolderAddRegular,
  FolderRegular,
  InfoRegular,
  MoreHorizontalRegular,
  PlugConnectedRegular,
  PlugDisconnectedRegular,
} from "@fluentui/react-icons";
import { useState } from "react";
import { ContextMenuPortal, ContextMenuSurface } from "../../app/ContextMenuPortal";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";
import type { InfoEntry, SessionRecord } from "../../ipc/types";
import { useExplorerStore } from "../../stores/useExplorerStore";
import { useSessionStore } from "../../stores/useSessionStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useTabStore } from "../../stores/useTabStore";
import { sectionLabel } from "../redis/info-labels";
import { InfoDialog } from "../info/InfoDialog";
import { ENGINE_COLORS, ENGINE_LABELS } from "./engine";
import { EngineIcon } from "./EngineIcon";

const UNGROUPED = "__ungrouped__";

const useStyles = makeStyles({
  root: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 8px 6px 14px",
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
  },
  list: {
    flex: 1,
    overflowY: "auto",
    padding: "0 4px 6px",
    display: "flex",
    flexDirection: "column",
  },
  menuOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 998,
  },
  menu: {
    position: "fixed",
    zIndex: 999,
    minWidth: "170px",
    padding: "4px",
    borderRadius: "6px",
    boxShadow: tokens.shadow16,
  },
  empty: {
    padding: "24px 16px",
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: "18px",
  },
  folderHeader: {
    display: "flex",
    alignItems: "center",
    gap: "5px",
    padding: "1px 4px 1px 8px",
    marginTop: "1px",
    borderRadius: "5px",
    color: tokens.colorNeutralForeground3,
    fontSize: "11px",
    fontWeight: tokens.fontWeightRegular,
    cursor: "default",
    transition: "background-color 140ms cubic-bezier(0.33, 0, 0.67, 1)",
    ":hover": { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  folderName: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  folderCount: {
    color: tokens.colorNeutralForeground4,
    fontWeight: tokens.fontWeightRegular,
  },
  folderActions: {
    display: "flex",
    alignItems: "center",
    opacity: 0,
    pointerEvents: "none",
    transition: "opacity 120ms cubic-bezier(0.33, 0, 0.67, 1)",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "5px",
    padding: "2px 6px",
    borderRadius: "5px",
    cursor: "default",
    transition: "background-color 140ms cubic-bezier(0.33, 0, 0.67, 1)",
    ":hover": { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  rowActive: {
    backgroundColor: tokens.colorBrandBackground2,
  },
  info: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
  },
  nameRow: { display: "flex", alignItems: "center", minWidth: 0 },
  readOnly: { flexShrink: 0, fontSize: "10px", color: tokens.colorNeutralForeground3 },
  name: {
    flex: "0 1 auto",
    minWidth: 0,
    fontSize: "12px",
    lineHeight: "16px",
    color: tokens.colorNeutralForeground1,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  meta: {
    fontSize: "10px",
    lineHeight: "12px",
    color: tokens.colorNeutralForeground3,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  dot: {
    width: "7px",
    height: "7px",
    borderRadius: "50%",
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralForeground4,
  },
  dotOn: {
    backgroundColor: "#6ccb5f",
  },
  accent: {
    width: "3px",
    height: "22px",
    borderRadius: "2px",
    flexShrink: 0,
    transition: "opacity 140ms cubic-bezier(0.33, 0, 0.67, 1)",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    opacity: 0,
    pointerEvents: "none",
    transition: "opacity 120ms cubic-bezier(0.33, 0, 0.67, 1)",
  },
  bottomBar: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "4px 6px",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  spacer: { flex: 1 },
});

function endpointLabel(session: SessionRecord): string {
  if (session.engine === "sqlite") {
    const file = session.filePath?.split(/[\\/]/).pop();
    return file ?? "SQLite";
  }
  const port = session.port ? `:${session.port}` : "";
  return `${session.host ?? ""}${port}`;
}

interface Props {
  toolbarTarget: HTMLElement | null;
  onNew: (group?: string | null) => void;
  onEdit: (session: SessionRecord) => void;
  onCopy?: (session: SessionRecord) => void;
}

export function SessionList({ onNew, onEdit, onCopy, toolbarTarget }: Props) {
  const styles = useStyles();
  const notify = useNotify();
  const sessions = useSessionStore((s) => s.sessions);
  const statuses = useSessionStore((s) => s.statuses);
  const folders = useSessionStore((s) => s.folders);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const connect = useSessionStore((s) => s.connect);
  const disconnect = useSessionStore((s) => s.disconnect);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const createFolder = useSessionStore((s) => s.createFolder);
  const deleteFolder = useSessionStore((s) => s.deleteFolder);
  const loadSessions = useSessionStore((s) => s.load);
  const clearSession = useExplorerStore((s) => s.clearSession);
  const closeSessionTabs = useTabStore((s) => s.closeSession);
  const loadPinnedTabs = useTabStore((s) => s.loadPinned);
  const restorePinnedTabs = useTabStore((s) => s.restorePinned);
  const collapsedFolders = useSettingsStore((s) => s.collapsedFolders);
  const setFolderCollapsed = useSettingsStore((s) => s.setFolderCollapsed);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SessionRecord | null>(null);
  const [pendingFolderDelete, setPendingFolderDelete] = useState<string | null>(null);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; session: SessionRecord } | null>(
    null,
  );
  const [infoDialog, setInfoDialog] = useState<{
    title: string;
    entries: InfoEntry[];
  } | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);

  const openServerInfo = async (session: SessionRecord) => {
    setMenu(null);
    if (!statuses[session.id]) {
      setBusyId(session.id);
      try {
        await connect(session.id);
        setActiveSession(session.id);
      } catch (error) {
        notify.error(error, "连接失败");
        return;
      } finally {
        setBusyId(null);
      }
    }
    setInfoLoading(true);
    setInfoDialog({ title: `服务器信息 · ${session.name}`, entries: [] });
    try {
      const entries = await api.serverInfo(session.id);
      const mapped =
        session.engine === "redis"
          ? entries.map((entry) => ({
              ...entry,
              section: sectionLabel(entry.section).label,
            }))
          : entries;
      setInfoDialog({ title: `服务器信息 · ${session.name}`, entries: mapped });
    } catch (error) {
      notify.error(error, "读取服务器信息失败");
      setInfoDialog(null);
    } finally {
      setInfoLoading(false);
    }
  };

  const toggleConnect = async (session: SessionRecord) => {
    if (busyId) return;
    setBusyId(session.id);
    try {
      if (statuses[session.id]) {
        if(!await confirmEdits(e=>e.sessionId===session.id))return;
        await disconnect(session.id);
        clearSession(session.id);
        if (activeSessionId === session.id) setActiveSession(null);
      } else {
        await connect(session.id);
        if (["mysql","postgres","sqlite"].includes(session.engine)) { await loadPinnedTabs(session.id); restorePinnedTabs(session.id); }
        setActiveSession(session.id);
      }
    } catch (error) {
      notify.error(error, statuses[session.id] ? "断开连接失败" : "连接失败");
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      if(!await confirmEdits(e=>e.sessionId===pendingDelete.id))return;
      await deleteSession(pendingDelete.id);
      clearSession(pendingDelete.id);
      closeSessionTabs(pendingDelete.id);
      notify.success("会话已删除", pendingDelete.name);
    } catch (error) {
      notify.error(error, "删除失败");
    } finally {
      setPendingDelete(null);
    }
  };

  const confirmFolderDelete = async () => {
    if (!pendingFolderDelete) return;
    try {
      await deleteFolder(pendingFolderDelete);
      notify.success("文件夹已删除", `「${pendingFolderDelete}」中的会话已移至未分组`);
    } catch (error) {
      notify.error(error, "删除文件夹失败");
    } finally {
      setPendingFolderDelete(null);
    }
  };

  const handleCreateFolder = async () => {
    try {
      await createFolder(folderName);
      setFolderDialogOpen(false);
      setFolderName("");
    } catch (error) {
      notify.error(error, "创建文件夹失败");
    }
  };

  const groups: Array<{ key: string; label: string; sessions: SessionRecord[] }> = folders.map(
    (folder) => ({
      key: folder,
      label: folder,
      sessions: sessions.filter((session) => session.groupName === folder),
    }),
  );
  const ungrouped = sessions.filter(
    (session) => !session.groupName || !folders.includes(session.groupName),
  );
  if (ungrouped.length > 0 || folders.length === 0) {
    groups.push({ key: UNGROUPED, label: "未分组", sessions: ungrouped });
  }

  const phases = useSessionStore(s => s.phases);
  const renderSession = (session: SessionRecord, grouped: boolean) => {
    const connected = Boolean(statuses[session.id]);
    const active = activeSessionId === session.id;
    const busy = busyId === session.id || phases[session.id]?.state === "connecting";
    return (
      <div
        key={session.id}
        className={mergeClasses(styles.row, active && styles.rowActive, "session-row")}
        style={grouped ? { marginLeft: "12px" } : undefined}
        onClick={() => setActiveSession(session.id)}
        onDoubleClick={() => void toggleConnect(session)}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, session });
        }}
      >
        <span
          className={styles.accent}
          style={{
            backgroundColor: ENGINE_COLORS[session.engine],
            opacity: active ? 1 : 0.4,
          }}
        />
        {busy ? (
          <Spinner size="tiny" />
        ) : (
          <EngineIcon engine={session.engine} size={16} />
        )}
        <div className={styles.info}>
          <span className={styles.nameRow}>
            <span className={styles.name} title={session.name}>{session.name}</span>
            <EnvironmentBadge sessionId={session.id} compact />
            {session.readOnly && <span className={styles.readOnly}>（只读）</span>}
          </span>
          <span className={styles.meta} title={`${ENGINE_LABELS[session.engine]} · ${endpointLabel(session)} · ${busy ? "连接中" : connected ? "已连接" : "未连接"}`}>
            {endpointLabel(session)}{busy ? " · 连接中…" : phases[session.id]?.error ? " · 连接失败" : ""}
          </span>
        </div>
        <span
          className={mergeClasses(styles.dot, connected && styles.dotOn)}
          style={phases[session.id]?.error ? { backgroundColor: tokens.colorStatusDangerForeground1 } : undefined}
          title={phases[session.id]?.error ?? (busy ? "连接中" : connected ? "已连接" : "已断开")}
        />
        <div
          className={mergeClasses(styles.actions, "session-actions")}
          onClick={(event) => event.stopPropagation()}
        >
          <Tooltip content={connected ? "断开连接" : phases[session.id] ? "重新连接" : "连接"} relationship="label">
            <Button
              appearance="subtle"
              size="small"
              icon={connected ? <PlugDisconnectedRegular /> : <PlugConnectedRegular />}
              disabled={busy}
              aria-label={connected ? "断开连接" : "重新连接"}
              onClick={() => void toggleConnect(session)}
            />
          </Tooltip>
        </div>
      </div>
    );
  };

  return (
    <div className={styles.root}>
      <div className={styles.list}>
        {sessions.length === 0 && (
          <div className={styles.empty}>
            还没有会话
            <br />
            点击标题栏 + 添加数据库连接
          </div>
        )}
        {groups.map((group) => {
          const isCollapsed = collapsedFolders.includes(group.key);
          return (
            <div key={group.key} style={{flexShrink:0}}>
              <div
                className={mergeClasses(styles.folderHeader, "session-folder")}
                onClick={() => void setFolderCollapsed(group.key, !isCollapsed)}
              >
                <FolderRegular fontSize={16} />
                <span className={styles.folderName}>{group.label}</span>
                <div
                  className={mergeClasses(styles.folderActions, "session-folder-actions")}
                  onClick={(event) => event.stopPropagation()}
                >
                  {group.key !== UNGROUPED && (
                    <Menu>
                      <MenuTrigger disableButtonEnhancement>
                        <Button
                          appearance="subtle"
                          size="small"
                          icon={<MoreHorizontalRegular />}
                          aria-label="文件夹操作"
                          style={{ minWidth: 22, width: 22, height: 22, padding: 0 }}
                        />
                      </MenuTrigger>
                      <MenuPopover>
                        <MenuList>
                          <MenuItem icon={<AddRegular />} onClick={() => onNew(group.key)}>
                            新建会话到此分组
                          </MenuItem>
                          <MenuItem
                            icon={<DeleteRegular />}
                            onClick={() => setPendingFolderDelete(group.key)}
                          >
                            删除文件夹
                          </MenuItem>
                        </MenuList>
                      </MenuPopover>
                    </Menu>
                  )}
                </div>
                <span className={styles.folderCount}>{group.sessions.length}</span>
                <ChevronRightRegular
                  fontSize={14}
                  style={{
                    transform: isCollapsed ? "none" : "rotate(90deg)",
                    transition: "transform 320ms cubic-bezier(.22,.7,.25,1)",
                    color: tokens.colorNeutralForeground3,
                  }}
                />
              </div>
              <div className="dw-session-group-body" data-expanded={!isCollapsed} aria-hidden={isCollapsed} inert={isCollapsed}>
                <div className="dw-session-group-clip">
                  {group.sessions.map((session) => renderSession(session, true))}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {toolbarTarget && createPortal(<>
        <Menu><MenuTrigger disableButtonEnhancement><Button appearance="subtle" size="small" icon={<AddRegular />} title="新建会话或分组" aria-label="新建会话或分组" /></MenuTrigger>
          <MenuPopover><MenuList>
            <MenuItem icon={<AddRegular />} onClick={() => onNew(null)}>新建会话</MenuItem>
            <MenuItem icon={<FolderAddRegular />} onClick={() => { setFolderName(""); setFolderDialogOpen(true); }}>新建分组</MenuItem>
          </MenuList></MenuPopover>
        </Menu>
        <Button appearance="subtle" size="small" icon={<ArrowClockwiseRegular />} title="刷新会话" aria-label="刷新会话" onClick={() => void loadSessions().catch(error => notify.error(error, "刷新会话失败"))} />
      </>, toolbarTarget)}

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(_, data) => {
          if (!data.open) setPendingDelete(null);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>删除会话</DialogTitle>
            <DialogContent>
              确定要删除会话「{pendingDelete?.name}」吗？已保存的密码也会一并清除。
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setPendingDelete(null)}>
                取消
              </Button>
              <Button appearance="primary" onClick={() => void confirmDelete()}>
                删除
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <InfoDialog
        open={infoDialog !== null}
        title={infoDialog?.title ?? ""}
        entries={infoDialog?.entries ?? []}
        loading={infoLoading}
        onClose={() => setInfoDialog(null)}
      />

      {menu && (
        <ContextMenuPortal>
          <div className={styles.menuOverlay} onClick={() => setMenu(null)} />
          <ContextMenuSurface
            className={`${styles.menu} dw-context-menu`} x={menu.x} y={menu.y}>
            <MenuList>
              <MenuItem
                disabled={busyId === menu.session.id || phases[menu.session.id]?.state === "connecting"}
                icon={
                  statuses[menu.session.id] ? (
                    <PlugDisconnectedRegular />
                  ) : (
                    <PlugConnectedRegular />
                  )
                }
                onClick={() => {
                  const target = menu.session;
                  setMenu(null);
                  void toggleConnect(target);
                }}
              >
                {statuses[menu.session.id] ? "断开连接" : phases[menu.session.id]?.state === "connecting" ? "连接中…" : phases[menu.session.id] ? "重新连接" : "连接"}
              </MenuItem>
              <MenuItem
                icon={<EditRegular />}
                onClick={() => {
                  const target = menu.session;
                  setMenu(null);
                  onEdit(target);
                }}
              >
                编辑会话
              </MenuItem>
              {onCopy && <MenuItem icon={<CopyRegular />} onClick={()=>{const source=menu.session;setMenu(null);onCopy(source);}}>复制会话</MenuItem>}
              <MenuItem
                icon={<InfoRegular />}
                onClick={() => void openServerInfo(menu.session)}
              >
                服务器信息
              </MenuItem>
              <MenuItem
                icon={<DeleteRegular />}
                onClick={() => {
                  const target = menu.session;
                  setMenu(null);
                  setPendingDelete(target);
                }}
              >
                删除会话
              </MenuItem>
            </MenuList>
          </ContextMenuSurface>
        </ContextMenuPortal>
      )}

      <Dialog
        open={pendingFolderDelete !== null}
        onOpenChange={(_, data) => {
          if (!data.open) setPendingFolderDelete(null);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>删除文件夹</DialogTitle>
            <DialogContent>
              确定要删除文件夹「{pendingFolderDelete}」吗？其中的会话将移动到「未分组」，
              不会删除会话本身。
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setPendingFolderDelete(null)}>
                取消
              </Button>
              <Button appearance="primary" onClick={() => void confirmFolderDelete()}>
                删除
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={folderDialogOpen}
        onOpenChange={(_, data) => {
          if (!data.open) setFolderDialogOpen(false);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>新建文件夹</DialogTitle>
            <DialogContent>
              <Field label="文件夹名称" required>
                <Input
                  value={folderName}
                  placeholder="例如：生产环境"
                  onChange={(_, data) => setFolderName(data.value)}
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setFolderDialogOpen(false)}>
                取消
              </Button>
              <Button
                appearance="primary"
                disabled={!folderName.trim()}
                onClick={() => void handleCreateFolder()}
              >
                创建
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
