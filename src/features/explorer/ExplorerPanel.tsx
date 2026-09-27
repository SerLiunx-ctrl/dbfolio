import { MongoExplorer } from "../mongo/MongoExplorer";
import { DockTitle } from "../../app/DockLayout";
import { ConnectionNotice } from "../../app/ConnectionNotice";
import {
  Button,
  MenuItem,
  MenuList,
  Spinner,
  Tree,
  TreeItem,
  TreeItemLayout,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  AddRegular,
  ArrowClockwiseRegular,
  ArrowExportRegular,
  CodeRegular,
  CopyRegular,
  DatabaseRegular,
  DeleteRegular,
  EyeFilled,
  EyeRegular,
  InfoRegular,
  KeyMultipleRegular,
  SettingsRegular,
  TableFilled,
  TableRegular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useState } from "react";
import { ContextMenuPortal, ContextMenuSurface } from "../../app/ContextMenuPortal";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";
import { formatBytes, type InfoEntry, type TableRef } from "../../ipc/types";
import { useExplorerStore } from "../../stores/useExplorerStore";
import { useSessionStore } from "../../stores/useSessionStore";
import { useTabStore } from "../../stores/useTabStore";
import { InfoDialog } from "../info/InfoDialog";
import { ConfirmSqlDialog } from "../table/ConfirmSqlDialog";
import { CreateTableDialog } from "../table/CreateTableDialog";
import { CreateDatabaseDialog } from "./CreateDatabaseDialog";
import { ObjectFinder } from "./ObjectFinder";
import { FavoriteButton } from "./FavoriteButton";

const useStyles = makeStyles({
  panel: {
    width: "100%",
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 8px 4px 10px",
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
  },
  treeWrap: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    padding: "0 6px 8px",
  },
  dbIcon: {
    color: tokens.colorBrandForeground1,
  },
  tableIcon: {
    color: tokens.colorPaletteGreenForeground2,
  },
  viewIcon: {
    color: tokens.colorPalettePurpleForeground2,
  },
  placeholder: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "10px",
    padding: "24px",
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: "20px",
  },
  loadingBox: {
    display: "flex",
    justifyContent: "center",
    paddingTop: "32px",
  },
  treeItem: {
    borderRadius: "4px",
    transition: "background-color 140ms cubic-bezier(0.33, 0, 0.67, 1)",
  },
  selected: {
    backgroundColor: tokens.colorSubtleBackgroundSelected,
  },
  contextOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 998,
  },
  contextMenu: {
    position: "fixed",
    zIndex: 999,
    minWidth: "180px",
    padding: "4px",
    borderRadius: "6px",
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow16,
  },
});

interface ContextMenuState {
  x: number;
  y: number;
  kind: "database" | "table";
  database: string;
  table?: TableRef;
}

export function ExplorerPanel(){const session=useSessionStore(s=>s.sessions.find(item=>item.id===s.activeSessionId));return session?.engine==="mongodb"?<MongoExplorer key={session.id} session={session}/>:<SqlExplorerPanel/>;}
function SqlExplorerPanel() {
  const styles = useStyles();
  const notify = useNotify();

  const sessions = useSessionStore((s) => s.sessions);
  const statuses = useSessionStore((s) => s.statuses);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  const databases = useExplorerStore((s) => s.databases);
  const tables = useExplorerStore((s) => s.tables);
  const loading = useExplorerStore((s) => s.loading);
  const loadDatabases = useExplorerStore((s) => s.loadDatabases);
  const loadTables = useExplorerStore((s) => s.loadTables);

  const openTable = useTabStore((s) => s.openTable);
  const openQuery = useTabStore((s) => s.openQuery);
  const openRedis = useTabStore((s) => s.openRedis);
  const tabs = useTabStore((s) => s.tabs);
  const activeTab = useTabStore((s) => s.tabs.find((tab) => tab.id === s.activeId));

  const [searchDatabases, setSearchDatabases] = useState<Record<string, string>>({});
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [createTable, setCreateTable] = useState<string | null>(null);
  const [createDatabase, setCreateDatabase] = useState(false);
  const [dropDatabase, setDropDatabase] = useState<string | null>(null);
  const [dropTable, setDropTable] = useState<{ database: string; table: TableRef } | null>(
    null,
  );
  const [infoDialog, setInfoDialog] = useState<{
    title: string;
    entries: InfoEntry[];
  } | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);

  const openDatabaseInfo = async (database: string) => {
    if (!session) return;
    setInfoLoading(true);
    setInfoDialog({ title: `数据库信息 · ${database}`, entries: [] });
    try {
      const entries = await api.databaseInfo(session.id, database);
      setInfoDialog({ title: `数据库信息 · ${database}`, entries });
    } catch (error) {
      notify.error(error, "读取数据库信息失败");
      setInfoDialog(null);
    } finally {
      setInfoLoading(false);
    }
  };

  const session = sessions.find((s) => s.id === activeSessionId) ?? null;
  const readOnly=!session || session.readOnly;
  const connected = session ? Boolean(statuses[session.id]) : false;
  // Stable partition keeps the existing order within user and system databases.
  const mysqlSystemDatabases = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
  const databaseList = session ? databases[session.id]
    ?.filter(db => !session.allowedDatabases || session.allowedDatabases.includes(db.name))
    .sort((a, b) => session.engine === 'mysql'
      ? Number(mysqlSystemDatabases.has(a.name.toLowerCase())) - Number(mysqlSystemDatabases.has(b.name.toLowerCase()))
      : 0) : undefined;
  const databasesLoading = session ? Boolean(loading[`db:${session.id}`]) : false;

  useEffect(() => {
    if (!session || !connected) return;
    if (databases[session.id]) return;
    loadDatabases(session.id).catch((error) => notify.error(error, "加载数据库列表失败"));
  }, [session, connected, databases, loadDatabases, notify]);

  const handleOpenChange = (value: string, open: boolean) => {
    if (!open || !session) return;
    if (value.startsWith("db:")) {
      const database = value.slice(3);
      setSearchDatabases(current => ({ ...current, [session.id]: database }));
      const loaded = tables[`tables:${session.id}:${database}`];
      if (!loaded) {
        loadTables(session.id, database).catch((error) =>
          notify.error(error, "加载数据表失败"),
        );
      }
    }
  };

  const handleTableClick = useCallback(
    (table: TableRef, database: string) => {
      if (!session) return;
      openTable({
        sessionId: session.id,
        database,
        schema: table.schema ?? null,
        table: table.name,
      });
    },
    [session, openTable],
  );


  const openContextMenu = (
    event: React.MouseEvent,
    state: Omit<ContextMenuState, "x" | "y">,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ ...state, x: event.clientX, y: event.clientY });
  };

  const refreshTables = (database: string) => {
    if (!session) return;
    loadTables(session.id, database).catch((error) =>
      notify.error(error, "刷新数据表失败"),
    );
  };

  return (
    <aside className={styles.panel}>
      <div className={styles.header}>
        <DockTitle panel="explorer"><span className={styles.headerTitle}>对象浏览器</span></DockTitle>
        {session && connected && session.engine !== "sqlite" && session.engine !== "redis" && (
          <Button
            appearance="subtle"
            size="small"
            icon={<AddRegular />}
            disabled={readOnly}
            title={readOnly ? "只读会话不能新建数据库" : "新建数据库"}
            onClick={() => setCreateDatabase(true)}
          />
        )}
      </div>

      {!session && (
        <div className={styles.placeholder}>
          <DatabaseRegular fontSize={36} />
          在左侧选择一个会话
          <br />
          双击会话可快速连接
        </div>
      )}

      {session && connected && <ObjectFinder key={session.id} sessionId={session.id} redis={session.engine === "redis"} preferredDatabase={searchDatabases[session.id] ?? (activeTab?.sessionId === session.id ? activeTab.database : undefined)} />}

      {session && !connected && (
        <div className={styles.placeholder}>
          <span>会话「{session.name}」</span>
          <ConnectionNotice sessionId={session.id} standalone />
        </div>
      )}

      {session && connected && databasesLoading && !databaseList && (
        <div className={styles.loadingBox}>
          <Spinner size="tiny" label="加载数据库…" />
        </div>
      )}

      {session && connected && databaseList && (
        <div className={styles.treeWrap}>
          <Tree
            aria-label="数据库对象"
            onOpenChange={(_, data) => handleOpenChange(String(data.value), data.open)}
          >
            {databaseList.map((database) => {
              if (session.engine === "redis") {
                const isSelected =
                  activeTab?.kind === "redis" &&
                  activeTab.sessionId === session.id &&
                  activeTab.database === database.name;
                return (
                  <TreeItem
                    key={database.name}
                    itemType="leaf"
                    value={`rdb:${database.name}`}
                  >
                    <TreeItemLayout
                      className={mergeClasses(styles.treeItem, isSelected && styles.selected)}
                      iconBefore={
                        <DatabaseRegular fontSize={16} className={styles.dbIcon} />
                      }
                      onClick={() =>
                        openRedis(
                          session.id,
                          database.name,
                          `${session.name} · ${database.name}`,
                        )
                      }
                      onContextMenu={(event) =>
                        openContextMenu(event, {
                          kind: "database",
                          database: database.name,
                        })
                      }
                    >
                      {database.name}
                      {database.comment ? (
                        <span
                          style={{
                            marginLeft: 6,
                            fontSize: 11,
                            color: tokens.colorNeutralForeground3,
                          }}
                        >
                          {database.comment}
                        </span>
                      ) : null}
                    </TreeItemLayout>
                  </TreeItem>
                );
              }
              const tableList = tables[`tables:${session.id}:${database.name}`];
              const tablesLoading = Boolean(loading[`tables:${session.id}:${database.name}`]);
              return (
                <TreeItem
                  key={database.name}
                  itemType="branch"
                  value={`db:${database.name}`}
                >
                  <TreeItemLayout
                    className={styles.treeItem}
                    iconBefore={
                      <DatabaseRegular fontSize={16} className={styles.dbIcon} />
                    }
                    onClick={() => { if(session&&session.engine!=="redis"){useExplorerStore.setState({selectedDatabase:{sessionId:session.id,database:database.name}});useTabStore.getState().setActive(null);} }}
                    onContextMenu={(event) =>
                      openContextMenu(event, { kind: "database", database: database.name })
                    }
                  >
                    {database.name}
                    {database.name === "main" && database.comment ? (
                      <span
                        style={{
                          marginLeft: 6,
                          fontSize: 11,
                          color: tokens.colorNeutralForeground3,
                        }}
                      >
                        {database.comment.split(/[\\/]/).pop()}
                      </span>
                    ) : null}
                  </TreeItemLayout>
                  <Tree aria-label={`${database.name} 对象`}>
                    {tablesLoading && !tableList && (
                      <TreeItem itemType="leaf" value={`loading:${database.name}`}>
                        <TreeItemLayout>加载中…</TreeItemLayout>
                      </TreeItem>
                    )}
                    {(tableList ?? []).map((table) => {
                      const isSelected =
                        activeTab?.kind === "table" &&
                        activeTab.sessionId === session.id &&
                        activeTab.database === database.name &&
                        activeTab.table === table.name;
                      const isOpen = tabs.some(
                        (tab) =>
                          tab.kind === "table" &&
                          tab.sessionId === session.id &&
                          tab.database === database.name &&
                          tab.table === table.name,
                      );
                      return (
                        <TreeItem
                          key={`${table.schema ?? ""}.${table.name}`}
                          itemType="leaf"
                          value={`tbl:${database.name}:${table.schema ?? ""}:${table.name}`}
                        >
                          <TreeItemLayout
                            className={mergeClasses(
                              styles.treeItem,
                              isSelected && styles.selected,
                            )}
                            iconBefore={
                              table.kind === "view" ? (
                                isOpen ? (
                                  <EyeFilled fontSize={16} className={styles.viewIcon} />
                                ) : (
                                  <EyeRegular fontSize={16} className={styles.viewIcon} />
                                )
                              ) : isOpen ? (
                                <TableFilled
                                  fontSize={16}
                                  className={styles.tableIcon}
                                />
                              ) : (
                                <TableRegular
                                  fontSize={16}
                                  className={styles.tableIcon}
                                />
                              )
                            }
                            title={[
                              table.engine,
                              table.rowEstimate !== null && table.rowEstimate !== undefined
                                ? `约 ${table.rowEstimate.toLocaleString()} 行`
                                : null,
                              table.sizeBytes != null ? `${session.engine === "mysql" ? "估算大小：" : ""}${formatBytes(table.sizeBytes)}` : null,
                              table.comment,
                              isOpen ? "已打开" : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                            onClick={() => handleTableClick(table, database.name)}
                            onContextMenu={(event) =>
                              openContextMenu(event, {
                                kind: "table",
                                database: database.name,
                                table,
                              })
                            }
                          >
                            <span
                              style={{
                                display: "flex",
                                alignItems: "center",
                                width: "100%",
                                gap: "8px",
                                minWidth: 0,
                              }}
                            >
                              <span
                                style={{
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {table.name}
                              </span>
                              <FavoriteButton item={{sessionId: session.id, database: database.name, schema: table.schema, kind: "table", name: table.name}} />
                              {table.sizeBytes != null ? (
                                <span
                                  style={{
                                    marginLeft: "auto",
                                    fontSize: "10px",
                                    color: tokens.colorNeutralForeground4,
                                    whiteSpace: "nowrap",
                                    flexShrink: 0,
                                  }}
                                >
                                  {formatBytes(table.sizeBytes)}
                                </span>
                              ) : null}
                            </span>
                          </TreeItemLayout>
                        </TreeItem>
                      );
                    })}
                  </Tree>
                </TreeItem>
              );
            })}
          </Tree>
        </div>
      )}

      {contextMenu && (
        <ContextMenuPortal>
          <div className={styles.contextOverlay} onClick={() => setContextMenu(null)} />
          <ContextMenuSurface
            className={`${styles.contextMenu} dw-context-menu`} x={contextMenu.x} y={contextMenu.y}>
            <MenuList>
              {session?.engine==='mysql'&&contextMenu.kind==='database'&&<><MenuItem onClick={()=>{useTabStore.getState().openMysqlTool(session.id,contextMenu.database,'import');setContextMenu(null);}}>导入 SQL 文件…</MenuItem><MenuItem onClick={()=>{useTabStore.getState().openMysqlTool(session.id,contextMenu.database,'objects');setContextMenu(null);}}>管理数据库对象…</MenuItem></>}
              {session?.engine==='mysql'&&contextMenu.kind==='database'&&<><MenuItem onClick={()=>{useTabStore.getState().openMysqlTool(session.id,contextMenu.database,'import');setContextMenu(null);}}>导入 SQL 文件…</MenuItem><MenuItem onClick={()=>{useTabStore.getState().openMysqlTool(session.id,contextMenu.database,'objects');setContextMenu(null);}}>管理数据库对象…</MenuItem></>}
              {session?.engine==="mysql" && (contextMenu.kind==="database" || contextMenu.table?.kind==="table") && <MenuItem icon={<ArrowExportRegular />} onClick={()=>{useTabStore.getState().openSqlExport({sessionId:session.id,database:contextMenu.database,tables:contextMenu.table?[contextMenu.table.name]:[],allTables:contextMenu.kind==="database"});window.dispatchEvent(new Event("dw:show-workspace"));setContextMenu(null);}}>导出 SQL 文件…</MenuItem>}
              {contextMenu.kind === "database" && session?.engine === "redis" ? (
                <>
                  <MenuItem
                    icon={<KeyMultipleRegular />}
                    onClick={() => {
                      if (session) {
                        openRedis(
                          session.id,
                          contextMenu.database,
                          `${session.name} · ${contextMenu.database}`,
                        );
                      }
                      setContextMenu(null);
                    }}
                  >
                    浏览键
                  </MenuItem>
                  <MenuItem
                    icon={<ArrowClockwiseRegular />}
                    onClick={() => {
                      if (session) {
                        loadDatabases(session.id).catch(() => {});
                      }
                      setContextMenu(null);
                    }}
                  >
                    刷新逻辑库
                  </MenuItem>
                  <MenuItem
                    icon={<CopyRegular />}
                    onClick={() => {
                      void navigator.clipboard.writeText(contextMenu.database);
                      notify.success("已复制逻辑库名", contextMenu.database);
                      setContextMenu(null);
                    }}
                  >
                    复制库名
                  </MenuItem>
                </>
              ) : contextMenu.kind === "database" ? (
                <>
                  <MenuItem
                    icon={<CodeRegular />}
                    onClick={() => {
                      if (session) openQuery(session.id, contextMenu.database);
                      setContextMenu(null);
                    }}
                  >
                    新建查询
                  </MenuItem>
                  {!readOnly && (<MenuItem
                    icon={<AddRegular />}
                    onClick={() => {
                      setCreateTable(contextMenu.database);
                      setContextMenu(null);
                    }}
                  >
                    新建表
                  </MenuItem>)}
                  <MenuItem
                    icon={<ArrowClockwiseRegular />}
                    onClick={() => {
                      refreshTables(contextMenu.database);
                      setContextMenu(null);
                    }}
                  >
                    刷新
                  </MenuItem>
                  <MenuItem
                    icon={<InfoRegular />}
                    onClick={() => {
                      const database = contextMenu.database;
                      setContextMenu(null);
                      void openDatabaseInfo(database);
                    }}
                  >
                    数据库信息
                  </MenuItem>
                  {session?.engine !== "sqlite" && (
                    <>
                      {!readOnly && (<MenuItem
                        icon={<AddRegular />}
                        onClick={() => {
                          setContextMenu(null);
                          setCreateDatabase(true);
                        }}
                      >
                        新建数据库
                      </MenuItem>)}
                      {!readOnly && (<MenuItem icon={<DeleteRegular />}
                        onClick={() => {
                          setDropDatabase(contextMenu.database);
                          setContextMenu(null);
                        }}
                      >
                        删除数据库
                      </MenuItem>)}
                    </>
                  )}
                </>
              ) : (
                <>
                  <MenuItem icon={<AddRegular />} disabled={contextMenu.table?.kind !== "table"} onClick={()=>{if(session&&contextMenu.table)window.dispatchEvent(new CustomEvent("dw:generation",{detail:{sessionId:session.id,database:contextMenu.database,schema:contextMenu.table.schema??null,object:contextMenu.table.name}}));setContextMenu(null);}}>生成测试数据…</MenuItem>
                  <MenuItem icon={<TableRegular />}
                    onClick={() => {
                      if (session && contextMenu.table) {
                        openTable({
                          sessionId: session.id,
                          database: contextMenu.database,
                          schema: contextMenu.table.schema ?? null,
                          table: contextMenu.table.name,
                        });
                      }
                      setContextMenu(null);
                    }}
                  >
                    打开数据
                  </MenuItem>
                  <MenuItem icon={<SettingsRegular />}
                    onClick={() => {
                      if (session && contextMenu.table) {
                        openTable(
                          {
                            sessionId: session.id,
                            database: contextMenu.database,
                            schema: contextMenu.table.schema ?? null,
                            table: contextMenu.table.name,
                          },
                          "structure",
                        );
                      }
                      setContextMenu(null);
                    }}
                  >
                    打开结构
                  </MenuItem>
                  <MenuItem
                    icon={<InfoRegular />}
                    onClick={() => {
                      if (session && contextMenu.table) {
                        openTable(
                          {
                            sessionId: session.id,
                            database: contextMenu.database,
                            schema: contextMenu.table.schema ?? null,
                            table: contextMenu.table.name,
                          },
                          "info",
                        );
                      }
                      setContextMenu(null);
                    }}
                  >
                    表信息
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      if (session && contextMenu.table) {
                        openTable(
                          {
                            sessionId: session.id,
                            database: contextMenu.database,
                            schema: contextMenu.table.schema ?? null,
                            table: contextMenu.table.name,
                          },
                          "ddl",
                        );
                      }
                      setContextMenu(null);
                    }}
                    icon={<EyeRegular />}
                  >
                    查看 DDL
                  </MenuItem>
                  {!readOnly && (<MenuItem icon={<DeleteRegular />}
                    onClick={() => {
                      setDropTable({
                        database: contextMenu.database,
                        table: contextMenu.table as TableRef,
                      });
                      setContextMenu(null);
                    }}
                  >
                    删除表
                  </MenuItem>)}
                </>
              )}
            </MenuList>
          </ContextMenuSurface>
        </ContextMenuPortal>
      )}

      {session && createDatabase && session.engine !== "sqlite" && session.engine !== "redis" && (
        <CreateDatabaseDialog
          open
          sessionId={session.id}
          engine={session.engine}
          onClose={() => setCreateDatabase(false)}
          onDone={() => loadDatabases(session.id).catch(() => {})}
        />
      )}

      {session && createTable && (
        <CreateTableDialog
          open
          sessionId={session.id}
          database={createTable}
          schema={null}
          engine={session.engine}
          onClose={() => setCreateTable(null)}
          onDone={() => refreshTables(createTable)}
        />
      )}

      <InfoDialog
        open={infoDialog !== null}
        title={infoDialog?.title ?? ""}
        entries={infoDialog?.entries ?? []}
        loading={infoLoading}
        onClose={() => setInfoDialog(null)}
      />

      {session && dropDatabase && (
        <ConfirmSqlDialog
          open
          title={`删除数据库 · ${dropDatabase}`}
          sessionId={session.id}
          warning={`将删除数据库 ${dropDatabase} 及其中的所有对象与数据，且不可恢复。`}
          loadPreview={() =>
            Promise.resolve([
              session.engine === "mysql"
                ? `DROP DATABASE \`${dropDatabase}\``
                : `DROP DATABASE "${dropDatabase}"`,
            ])
          }
          onApply={async () => {
            await api.ddlDropDatabase(session.id, dropDatabase, true);
            notify.success("数据库已删除", dropDatabase);
          }}
          onClose={() => setDropDatabase(null)}
          onDone={() => {
            loadDatabases(session.id).catch(() => {});
          }}
        />
      )}

      {session && dropTable && (
        <ConfirmSqlDialog
          open
          title={`删除表 · ${dropTable.table.name}`}
          sessionId={session.id}
          warning={`将删除表 ${dropTable.table.name} 及其全部数据，且不可恢复。`}
          loadPreview={() =>
            api.ddlPreview(session.id, dropTable.database, {
              type: "dropTable",
              schema: dropTable.table.schema ?? null,
              table: dropTable.table.name,
            })
          }
          onApply={async () => {
            await api.ddlApply(
              session.id,
              dropTable.database,
              {
                type: "dropTable",
                schema: dropTable.table.schema ?? null,
                table: dropTable.table.name,
              },
              true,
            );
            notify.success("表已删除", dropTable.table.name);
          }}
          onClose={() => setDropTable(null)}
          onDone={() => refreshTables(dropTable.database)}
        />
      )}
    </aside>
  );
}
