import {useSessionReadOnly} from "../../stores/useSessionReadOnly";
import {InfoHint} from '../../common/InfoHint';
import './redis-keys.css';
import { confirmEdits } from "../../stores/useEditGuard";
import { useObjectNavigation } from "../../stores/useObjectNavigation";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Input,
  MenuItem,
  MenuList,
  Option,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Tree,
  TreeItem,
  TreeItemLayout,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowClockwiseRegular,
  ArrowLeftRegular,
  ArrowRightRegular,
  ArrowSyncRegular,
  AddRegular,
  CopyRegular,
  DeleteRegular,
  DismissRegular,
  FolderRegular,
  KeyMultipleRegular,
  RenameRegular,
  SearchRegular,
  TimerRegular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { ContextMenuPortal, ContextMenuSurface } from "../../app/ContextMenuPortal";
import { ResizeHandle } from "../../app/ResizeHandle";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";
import type { RedisKeyInfo } from "../../ipc/types";
import {
  useSettingsStore,
  DEFAULT_REDIS_PREVIEW_WIDTH,
  DEFAULT_REDIS_TREE_WIDTH,
} from "../../stores/useSettingsStore";
import { type RedisTab } from "../../stores/useTabStore";
import { REDIS_TYPE_OPTIONS, formatBytes, formatTtl, typeBadgeColor } from "./format";
import { RedisKeyActionDialogs } from "./RedisKeyActionDialogs";
import { RedisKeyPanel } from "./RedisKeyPanel";
import { RedisNewKeyDialog } from "./RedisNewKeyDialog";
import type { RedisKeyChange, RedisKeyDialog } from "./keyTypes";

const useStyles = makeStyles({
  wrap: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px 12px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    flexShrink: 0,
    flexWrap: "wrap",
  },
  patternInput: { width: "220px" },
  spacer: { flex: 1 },
  status: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    whiteSpace: "nowrap",
  },
  body: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    display: "flex",
    overflow: "auto",
  },
  treePane: {
    flexShrink: 0,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    overflow: "auto",
    padding: "4px 0 12px",
  },
  treeCompact: {
    "& .fui-TreeItemLayout": {
      minHeight: "22px",
      fontSize: tokens.fontSizeBase200,
    },
    "& .fui-TreeItemLayout__expandIcon": {
      minWidth: "18px",
    },
  },
  subTree: {
    marginLeft: "12px",
    borderLeft: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  keyTable: {
    // 36 复选框 + 至少 240 键名 + 80 类型 + 110 TTL + 90 内存。
    minWidth: "556px",
    width: "100%",
    tableLayout: "fixed",
  },
  tablePane: {
    flex: "1 0 280px",
    minWidth: "280px",
    overflow: "auto",
    padding: "0 0 24px",
  },
  previewPane: {
    flexShrink: 0,
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    overflow: "auto",
    display: "flex",
    flexDirection: "column",
  },
  previewHeader: {
    padding: "10px 12px 8px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    position: "sticky",
    top: 0,
    background: tokens.colorNeutralBackground1,
    zIndex: 1,
  },
  previewKey: {
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    wordBreak: "break-all",
    userSelect: "text",
  },
  previewActions: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    marginTop: "6px",
    flexWrap: "wrap",
  },
  previewMeta: {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px 8px",
    padding: "8px 12px",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  previewBody: {
    padding: "8px 12px 24px",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  entryRow: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    gap: "8px",
    alignItems: "start",
    padding: "3px 0",
    borderBottom: `1px dashed ${tokens.colorNeutralStroke3}`,
    fontSize: tokens.fontSizeBase200,
  },
  entryIndex: {
    color: tokens.colorNeutralForeground4,
    minWidth: "18px",
    textAlign: "right",
    fontFamily: '"Cascadia Mono", Consolas, monospace',
  },
  entryField: {
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    color: tokens.colorNeutralForeground3,
    wordBreak: "break-all",
  },
  entryValue: {
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    wordBreak: "break-all",
    whiteSpace: "pre-wrap",
    userSelect: "text",
  },
  stringValue: {
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    userSelect: "text",
    background: tokens.colorNeutralBackground3,
    borderRadius: "6px",
    padding: "8px 10px",
  },
  placeholder: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    padding: "24px 16px",
    textAlign: "center",
  },
  selectedRow: {
    background: "color-mix(in srgb, var(--dw-accent) 12%, transparent)",
  },
  contextOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 998,
  },
  contextMenu: {
    position: "fixed",
    zIndex: 999,
    minWidth: "170px",
    padding: "4px",
    borderRadius: "6px",
    boxShadow: tokens.shadow16,
  },
  keyCell: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    fontSize: tokens.fontSizeBase200,
    userSelect: "text",
  },
  folderLabel: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    minWidth: 0,
    width: "100%",
  },
  folderName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  folderCount: {
    marginLeft: "auto",
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground4,
  },
  treeRoot: {
    cursor: "pointer",
    fontWeight: tokens.fontWeightSemibold,
  },
  note: {
    padding: "6px 12px",
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground4,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    flexShrink: 0,
  },
});

interface FolderNode {
  path: string;
  name: string;
  count: number;
  children: Map<string, FolderNode>;
}

function buildTree(keys: RedisKeyInfo[]): FolderNode {
  const root: FolderNode = { path: "", name: "", count: keys.length, children: new Map() };
  for (const info of keys) {
    const segments = info.key.split(":").filter((segment) => segment.length > 0);
    if (segments.length < 2) continue;
    let node = root;
    let path = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      path = path ? `${path}:${segment}` : segment;
      let child = node.children.get(segment);
      if (!child) {
        child = { path, name: segment, count: 0, children: new Map() };
        node.children.set(segment, child);
      }
      child.count += 1;
      node = child;
    }
  }
  return root;
}

function firstLevelPaths(root: FolderNode): string[] {
  return [...root.children.values()].map((node) => `folder:${node.path}`);
}

interface Props {
  tab: RedisTab;
}

type SortKey = "key" | "ttl" | "size";

const sortDirection = (
  sort: { key: SortKey; dir: "asc" | "desc" } | null,
  key: SortKey,
): "ascending" | "descending" | undefined => {
  if (!sort || sort.key !== key) return undefined;
  return sort.dir === "asc" ? "ascending" : "descending";
};

export function RedisKeysView({ tab }: Props) {
  const readOnly=useSessionReadOnly(tab.sessionId);
  const styles = useStyles();
  const notify = useNotify();
  const redisTreeWidth = useSettingsStore((s) => s.redisTreeWidth);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyWidth,setBodyWidth] = useState(1200);
  const [showTree,setShowTree] = useState(false);
  const [showDetail,setShowDetail] = useState(false);
  const compact = bodyWidth < 1000;
  const narrow = bodyWidth < 720;
  useEffect(()=>{
    const element=bodyRef.current;
    if(!element) return;
    const observer=new ResizeObserver(([entry])=>setBodyWidth(entry.contentRect.width));
    observer.observe(element);
    return ()=>observer.disconnect();
  },[]);
  const redisPreviewWidth = useSettingsStore((s) => s.redisPreviewWidth);
  const setRedisTreeWidth = useSettingsStore((s) => s.setRedisTreeWidth);
  const setRedisPreviewWidth = useSettingsStore((s) => s.setRedisPreviewWidth);

  const databaseIndex = useMemo(() => {
    const text = tab.database.startsWith("db") ? tab.database.slice(2) : tab.database;
    const parsed = Number.parseInt(text, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [tab.database]);

  const [patternInput, setPatternInput] = useState("*");
  const patternRef = useRef("*");
  const [keyType, setKeyType] = useState("");
  const [keys, setKeys] = useState<RedisKeyInfo[]>([]);
  const keysRef = useRef<RedisKeyInfo[]>([]);
  const cursorRef = useRef(0);
  const [done, setDone] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const [activePrefix, setActivePrefix] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  useEffect(()=>{setShowDetail(Boolean(selectedKey));},[selectedKey]);
  const navigation = useObjectNavigation(state => state.request);
  useEffect(() => {
    if (!navigation || navigation.tabId !== tab.id) return;
    useObjectNavigation.setState({request: null});
    void confirmEdits(e => e.tabId === tab.id).then(allowed => { if(allowed) {setSelectedKey(navigation.key);setShowDetail(true);} });
  }, [navigation, tab.id]);
  const [newKeyOpen, setNewKeyOpen] = useState(false);
  const [keyDialog, setKeyDialog] = useState<RedisKeyDialog | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const scanVersion = useRef(0);

  const runScan = useCallback(
    async (reset: boolean, keepContext = false) => {
      const version = ++scanVersion.current;
      const pattern = patternRef.current;
      setScanning(true);
      try {
        let collected = reset ? [] : keysRef.current;
        let next = reset ? 0 : cursorRef.current;
        for (let round = 0; round < 20; round += 1) {
          const page = await api.redisScanKeys(
            tab.sessionId,
            databaseIndex,
            next,
            pattern,
            keyType || null,
            200,
          );
          if (version !== scanVersion.current) return;
          collected = collected.concat(page.keys);
          next = page.cursor;
          if (next === 0 || page.keys.length > 0) break;
        }
        collected = [...new Map(collected.map(info => [info.key, info])).values()];
        keysRef.current = collected;
        cursorRef.current = next;
        setKeys(collected);
        setDone(next === 0);
        if (reset && !keepContext) {
          setSelectedKey(null);
          setActivePrefix(null);
          setOpenFolders(new Set(firstLevelPaths(buildTree(collected))));
          setSelected(new Set());
        } else if (reset) {
          const present = new Set(collected.map((info) => info.key));
          setSelected((current) => {
            const next = new Set([...current].filter((key) => present.has(key)));
            return next.size === current.size ? current : next;
          });
        }
      } catch (error) {
        if (version === scanVersion.current) notify.error(error, "扫描键失败");
      } finally {
        if (version === scanVersion.current) setScanning(false);
      }
    },
    [tab.sessionId, databaseIndex, keyType, notify],
  );

  const prevDatabaseRef = useRef(databaseIndex);
  useEffect(() => {
    const databaseChanged = prevDatabaseRef.current !== databaseIndex;
    prevDatabaseRef.current = databaseIndex;
    void runScan(true, !databaseChanged);
    return () => { scanVersion.current++; };
  }, [runScan, databaseIndex]);

  const selectKey = async (key: string) => {
    if(key !== selectedKey && !await confirmEdits(e=>e.tabId===tab.id))return;
    setSelectedKey(key);
  };

  const handleKeyChanged = (change: RedisKeyChange) => {
    if (change.deleted) {
      setSelectedKey(null);
      void runScan(true, true);
    } else if (change.renamed) {
      setSelectedKey(change.renamed);
      void runScan(true, true);
    } else {
      void runScan(true, true);
    }
  };

  const handleKeyCreated = async (key: string) => {
    await runScan(true, true);
    setSelectedKey(key);
  };

  const openKeyDialog = async (kind: RedisKeyDialog, key: string) => {
    if(readOnly)return;
    if(!await confirmEdits(e=>e.tabId===tab.id))return;
    setSelectedKey(key);
    setKeyDialog(kind);
    setMenu(null);
  };

  const applyPattern = async (next: string) => {
    if(!await confirmEdits(e=>e.tabId===tab.id))return;
    patternRef.current = next.trim() || "*";
    setPatternInput(patternRef.current);
    void runScan(true);
  };

  const tree = useMemo(() => buildTree(keys), [keys]);

  const visibleKeys = useMemo(
    () =>
      activePrefix
        ? keys.filter((info) => info.key.startsWith(`${activePrefix}:`))
        : keys,
    [keys, activePrefix],
  );

  const sortedKeys = useMemo(() => {
    if (!sort) return visibleKeys;
    const list = [...visibleKeys];
    const direction = sort.dir === "asc" ? 1 : -1;
    list.sort((left, right) => {
      if (sort.key === "key") {
        return left.key.localeCompare(right.key) * direction;
      }
      if (sort.key === "ttl") {
        const leftTtl = left.ttlMs < 0 ? Number.POSITIVE_INFINITY : left.ttlMs;
        const rightTtl = right.ttlMs < 0 ? Number.POSITIVE_INFINITY : right.ttlMs;
        return (leftTtl - rightTtl) * direction;
      }
      const leftSize = left.size ?? -1;
      const rightSize = right.size ?? -1;
      return (leftSize - rightSize) * direction;
    });
    return list;
  }, [visibleKeys, sort]);

  const toggleSort = (key: SortKey) => {
    setSort((current) => {
      if (current && current.key === key) {
        return { key, dir: current.dir === "asc" ? "desc" : "asc" };
      }
      return { key, dir: "asc" };
    });
  };

  const allVisibleSelected =
    sortedKeys.length > 0 && sortedKeys.every((info) => selected.has(info.key));
  const someVisibleSelected = sortedKeys.some((info) => selected.has(info.key));

  const toggleRowSelected = (key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const info of sortedKeys) next.delete(info.key);
      } else {
        for (const info of sortedKeys) next.add(info.key);
      }
      return next;
    });
  };

  const handleBatchDelete = async () => {
    if(readOnly)return;
    if (selected.size === 0) return;
    if (selectedKey && selected.has(selectedKey) && !(await confirmEdits(e => e.tabId === tab.id))) return;
    setBatchBusy(true);
    try {
      const keys = [...selected];
      const deleted = await api.redisDeleteKeys(tab.sessionId, databaseIndex, keys);
      notify.success("批量删除完成", `删除 ${deleted} 个键`);
      if (selectedKey && keys.includes(selectedKey)) setSelectedKey(null);
      setSelected(new Set());
      setBatchOpen(false);
      await runScan(true, true);
    } catch (error) {
      notify.error(error, "批量删除失败");
    } finally {
      setBatchBusy(false);
    }
  };

  const selectPrefix = (path: string) => {
    setActivePrefix(path);
    setOpenFolders((current) => {
      const value = `folder:${path}`;
      if (current.has(value)) return current;
      const next = new Set(current);
      next.add(value);
      return next;
    });
  };

  const toggleFolder = (value: string, open: boolean) => {
    setOpenFolders((current) => {
      const next = new Set(current);
      if (open) next.add(value);
      else next.delete(value);
      return next;
    });
  };

  const renderFolders = (node: FolderNode): ReactElement[] =>
    [...node.children.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((child) => {
        const active = activePrefix === child.path;
        const expandable = child.children.size > 0;
        return (
          <TreeItem
            key={child.path}
            itemType={expandable ? "branch" : "leaf"}
            value={`folder:${child.path}`}
          >
            <TreeItemLayout
              style={{ paddingLeft: "8px" }}
              className={mergeClasses(active && styles.selectedRow)}
              iconBefore={
                expandable ? (
                  <FolderRegular fontSize={14} />
                ) : (
                  <KeyMultipleRegular fontSize={14} />
                )
              }
              onClick={(event) => {
                const target = event.target as HTMLElement;
                if (target.closest(".fui-TreeItemLayout__expandIcon")) return;
                event.stopPropagation();
                selectPrefix(child.path);
              }}
            >
              <span className={styles.folderLabel}>
                <span className={styles.folderName} title={child.path}>
                  {child.name}
                </span>
                <span className={styles.folderCount}>{child.count}</span>
              </span>
            </TreeItemLayout>
            {expandable && (
              <div className={styles.subTree}>
                <Tree>{renderFolders(child)}</Tree>
              </div>
            )}
          </TreeItem>
        );
      });

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        {compact && <Button size="small" icon={<FolderRegular />} aria-expanded={showTree} onClick={()=>setShowTree(value=>!value)}>{showTree ? "收起前缀" : "前缀筛选"}</Button>}
        {narrow && showDetail && selectedKey && <Button size="small" icon={<ArrowLeftRegular />} onClick={()=>setShowDetail(false)}>返回键列表</Button>}
        {narrow && !showDetail && selectedKey && <Button size="small" icon={<ArrowRightRegular />} onClick={()=>setShowDetail(true)}>查看详情</Button>}
        <Badge appearance="outline" size="small">
          {tab.database}
        </Badge>
        <Input
          size="small"
          className={styles.patternInput}
          value={patternInput}
          placeholder="匹配模式，如 user:*"
          contentBefore={<SearchRegular fontSize={12} />}
          onChange={(_, data) => setPatternInput(data.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") applyPattern(patternInput);
          }}
        />
        <Button
          size="small"
          appearance="primary"
          onClick={() => applyPattern(patternInput)}
          disabled={scanning}
        >
          搜索
        </Button>
        <Dropdown
          size="small"
          style={{ minWidth: 120 }}
          selectedOptions={[keyType]}
          value={REDIS_TYPE_OPTIONS.find((option) => option.value === keyType)?.label ?? "全部类型"}
          onOptionSelect={(_, data) => setKeyType(data.optionValue ?? "")}
        >
          {REDIS_TYPE_OPTIONS.map((option) => (
            <Option key={option.value} value={option.value}>
              {option.label}
            </Option>
          ))}
        </Dropdown>
        <Button
          size="small"
          appearance="subtle"
          icon={<AddRegular />}
          disabled={readOnly} title={readOnly?"只读会话不能新建键":undefined}
          onClick={async () => {if(!readOnly && await confirmEdits(e=>e.tabId===tab.id))setNewKeyOpen(true);}}
        >
          新建键
        </Button>
        <Button size="small" appearance="subtle" icon={<AddRegular/>} onClick={()=>window.dispatchEvent(new CustomEvent("dw:generation",{detail:{sessionId:tab.sessionId,database:tab.database,object:"keys"}}))}>数据生成</Button>
        <Button
          size="small"
          appearance="subtle"
          icon={<ArrowClockwiseRegular />}
          disabled={scanning}
          onClick={() => void runScan(true, true)}
        >
          刷新
        </Button>
        <div className={styles.spacer} />
        {selected.size > 0 && (
          <>
            <span className={styles.status}>已选 {selected.size} 个键</span>
            <Button size="small" appearance="subtle" onClick={() => setSelected(new Set())}>
              清除选择
            </Button>
            <Button
              size="small"
              appearance="primary"
              icon={<DeleteRegular fontSize={14} />}
              disabled={readOnly}
              onClick={() => setBatchOpen(true)}
            >
              批量删除
            </Button>
          </>
        )}
        {activePrefix && (
          <Button
            size="small"
            appearance="subtle"
            icon={<DismissRegular fontSize={12} />}
            onClick={() => setActivePrefix(null)}
          >
            {`前缀 ${activePrefix}:*`}
          </Button>
        )}
        <Button
          size="small"
          icon={scanning ? <Spinner size="tiny" /> : <ArrowSyncRegular />}
          disabled={scanning || done}
          onClick={() => void runScan(false)}
        >
          继续扫描
        </Button>
      </div>

      <div className={styles.body} ref={bodyRef} style={{position:"relative",overflow:"hidden"}}>
        <div className={styles.treePane} style={{ width: compact ? Math.min(240,bodyWidth) : redisTreeWidth, display:compact && !showTree ? "none" : undefined,
          ...(compact ? {position:"absolute",inset:"0 auto 0 0",zIndex:3,background:tokens.colorNeutralBackground1,boxShadow:tokens.shadow8} as const : {}) }}>
          <Tree
            aria-label="键前缀树"
            className={styles.treeCompact}
            openItems={openFolders}
            onOpenChange={(_, data) => {
              const value = String(data.value);
              if (value.startsWith("folder:")) {
                toggleFolder(value, data.open);
              }
            }}
          >
            <TreeItem itemType="leaf" value="root">
              <TreeItemLayout
                style={{ paddingLeft: "8px" }}
                className={mergeClasses(
                  styles.treeRoot,
                  activePrefix === null && styles.selectedRow,
                )}
                iconBefore={<FolderRegular fontSize={14} />}
                onClick={() => setActivePrefix(null)}
              >
                全部键
                <span className={styles.folderCount}>{tree.count}</span>
              </TreeItemLayout>
            </TreeItem>
            {renderFolders(tree)}
          </Tree>
        </div>

        {!compact && <ResizeHandle
          value={redisTreeWidth || DEFAULT_REDIS_TREE_WIDTH}
          min={160}
          max={480}
          onChange={(value) => setRedisTreeWidth(value, false)}
          onCommit={(value) => setRedisTreeWidth(value)}
        />}

        <div className={styles.tablePane} style={{display:narrow && showDetail && selectedKey ? "none" : undefined,minWidth:0,flex:"1 1 280px"}}>
          {scanning && keys.length === 0 ? (
            <div className={styles.placeholder}>
              <Spinner size="tiny" label="扫描键…" />
            </div>
          ) : visibleKeys.length === 0 ? (
            <div className={styles.placeholder}>
              {activePrefix ? "该前缀下暂无已加载键" : "没有匹配的键"}
              <br />
              （SCAN 在数据量大时可能需要多次「继续扫描」）
            </div>
          ) : (
            <Table size="extra-small" aria-label="Redis 键列表" className={mergeClasses(styles.keyTable,"dw-redis-key-table")}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell style={{ width: 36 }}>
                    <Checkbox
                      checked={
                        allVisibleSelected
                          ? true
                          : someVisibleSelected
                            ? "mixed"
                            : false
                      }
                      onChange={() => toggleAllVisible()}
                      aria-label="全选当前列表"
                    />
                  </TableHeaderCell>
                  <TableHeaderCell
                    sortDirection={sortDirection(sort, "key")}
                    onClick={() => toggleSort("key")}
                    style={{ cursor: "pointer" }}
                  >
                    键名
                  </TableHeaderCell>
                  <TableHeaderCell style={{ width: 80 }}>类型</TableHeaderCell>
                  <TableHeaderCell
                    style={{ width: 110, cursor: "pointer" }}
                    sortDirection={sortDirection(sort, "ttl")}
                    onClick={() => toggleSort("ttl")}
                  >
                    TTL
                  </TableHeaderCell>
                  <TableHeaderCell
                    style={{ width: 90, cursor: "pointer" }}
                    sortDirection={sortDirection(sort, "size")}
                    onClick={() => toggleSort("size")}
                    title="键实际内存占用（MEMORY USAGE，扫描时采样）"
                  >
                    内存
                  </TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedKeys.map((info) => (
                  <TableRow
                    key={info.key}
                    className={mergeClasses(
                      info.key === selectedKey && styles.selectedRow,
                    )}
                    onClick={async () => {await selectKey(info.key);setShowDetail(true);setShowTree(false);}}
                    onContextMenu={async (event) => {
                      event.preventDefault();
                      const x=event.clientX,y=event.clientY;
                      if(info.key!==selectedKey&&!await confirmEdits(e=>e.tabId===tab.id))return;
                      setSelectedKey(info.key);
                      setMenu({ x, y, key: info.key });
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <TableCell
                      style={{ width: 36 }}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Checkbox
                        checked={selected.has(info.key)}
                        onChange={() => toggleRowSelected(info.key)}
                        aria-label={`选择 ${info.key}`}
                      />
                    </TableCell>
                    <TableCell>
                      <span className={styles.keyCell} title={info.key}>{info.key}</span>
                    </TableCell>
                    <TableCell>
                      <Badge appearance="tint" size="small" color={typeBadgeColor(info.kind)}>
                        {info.kind}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatTtl(info.ttlMs)}</TableCell>
                    <TableCell>{formatBytes(info.size)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {!narrow && <ResizeHandle
          invert
          value={redisPreviewWidth || DEFAULT_REDIS_PREVIEW_WIDTH}
          min={240}
          max={720}
          onChange={(value) => setRedisPreviewWidth(value, false)}
          onCommit={(value) => setRedisPreviewWidth(value)}
        />}

        <div className={styles.previewPane} style={{ width: narrow ? "100%" : Math.min(redisPreviewWidth,bodyWidth*0.55), minWidth:0,
          display:narrow && (!showDetail || !selectedKey) ? "none" : undefined }}>
          <RedisKeyPanel
            tab={tab}
            keyName={selectedKey}
            onChanged={handleKeyChanged}
            onAction={(action) => {if(selectedKey)void openKeyDialog(action,selectedKey);}}
          />
        </div>
      </div>
      <InfoHint label="扫描与排序说明">
        基于 SCAN 游标遍历（不禁用服务器）；「继续扫描」按游标追加下一页。点击前缀节点仅筛选当前已加载键，不改变搜索模式；表头排序仅作用于已加载数据。
      </InfoHint>

      <RedisNewKeyDialog
        tab={tab}
        open={newKeyOpen}
        onClose={() => setNewKeyOpen(false)}
        onCreated={(key) => void handleKeyCreated(key)}
      />
      <RedisKeyActionDialogs
        tab={tab}
        keyName={selectedKey}
        dialog={keyDialog}
        onClose={() => setKeyDialog(null)}
        onChanged={handleKeyChanged}
      />

      <Dialog
        open={batchOpen}
        onOpenChange={(_, data) => {
          if (!data.open) setBatchOpen(false);
        }}
      >
        <DialogSurface style={{ maxWidth: "520px" }}>
          <DialogBody>
            <DialogTitle>批量删除键</DialogTitle>
            <DialogContent>
              确定要删除选中的 {selected.size} 个键吗？该操作不可恢复。
              <div
                className={styles.status}
                style={{
                  marginTop: 8,
                  maxHeight: 160,
                  overflow: "auto",
                  fontFamily: '"Cascadia Mono", Consolas, monospace',
                  whiteSpace: "pre-wrap",
                }}
              >
                {[...selected].slice(0, 50).join("\n")}
                {selected.size > 50 ? `\n… 其余 ${selected.size - 50} 个` : ""}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setBatchOpen(false)}>
                取消
              </Button>
              <Button
                appearance="primary"
                disabled={readOnly || batchBusy}
                onClick={() => void handleBatchDelete()}
              >
                删除 {selected.size} 个键
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {menu && (
        <ContextMenuPortal>
          <div className={styles.contextOverlay} onClick={() => setMenu(null)} />
          <ContextMenuSurface
            className={`${styles.contextMenu} dw-context-menu`} x={menu.x} y={menu.y}>
            <MenuList>
              <MenuItem
                icon={<ArrowRightRegular />}
                onClick={() => {
                  selectKey(menu.key);
                  setMenu(null);
                }}
              >
                {readOnly ? "查看" : "查看 / 编辑"}
              </MenuItem>
              <MenuItem
                icon={<CopyRegular />}
                onClick={() => {
                  void navigator.clipboard.writeText(menu.key);
                  notify.success("已复制键名", menu.key);
                  setMenu(null);
                }}
              >
                复制键名
              </MenuItem>
              {!readOnly && (<MenuItem
                icon={<RenameRegular />}
                onClick={() => openKeyDialog("rename", menu.key)}
              >
                重命名
              </MenuItem>)}
              {!readOnly && (<MenuItem
                icon={<TimerRegular />}
                onClick={() => openKeyDialog("ttl", menu.key)}
              >
                设置 TTL
              </MenuItem>)}
              <MenuItem
                icon={<ArrowClockwiseRegular />}
                onClick={() => {
                  void runScan(true, true);
                  setMenu(null);
                }}
              >
                刷新列表
              </MenuItem>
              {!readOnly && (<MenuItem
                icon={<DeleteRegular />}
                onClick={() => {
                  if (selected.has(menu.key) && selected.size > 1) {
                    setMenu(null);
                    setBatchOpen(true);
                  } else {
                    openKeyDialog("delete", menu.key);
                  }
                }}
              >
                {selected.has(menu.key) && selected.size > 1
                  ? `删除选中的 ${selected.size} 个键`
                  : "删除"}
              </MenuItem>)}
            </MenuList>
          </ContextMenuSurface>
        </ContextMenuPortal>
      )}
    </div>
  );
}
