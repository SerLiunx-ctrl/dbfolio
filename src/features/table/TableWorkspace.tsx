import { openAnalysis } from "../analysis/AnalysisWorkspace";
import { newPlan } from "../analysis/model";
import { qualifiedTableSql } from "../grid/value";
import {
  Badge,
  Button,
  Spinner,
  Tab,
  TabList,
  Tag,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { DataBarVerticalRegular, AddRegular, ArrowClockwiseRegular, CodeRegular } from "@fluentui/react-icons";
import {
  ArrowSortRegular,
  ColumnTripleRegular,
  GridRegular,
  InfoRegular,
  LinkRegular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../ipc";
import type { TableMeta } from "../../ipc/types";
import { useSessionStore } from "../../stores/useSessionStore";
import { confirmEdits } from "../../stores/useEditGuard";
import { useTabStore, type TableTab, type TableView } from "../../stores/useTabStore";
import { ENGINE_COLORS } from "../sessions/engine";
import {
  ColumnsPanel,
  DdlPanel,
  ForeignKeysPanel,
  IndexesPanel,
} from "./StructurePanel";
import { InfoPanel } from "./InfoPanel";
import { TableDataPanel } from "./TableDataPanel";

const useStyles = makeStyles({
  root: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "10px",
    padding: "8px 12px 6px",
    flexShrink: 0,
    background:
      "linear-gradient(90deg, color-mix(in srgb, var(--dw-accent) 10%, transparent), transparent 65%)",
  },
  title: {
    minWidth: 0,
    overflowWrap: "anywhere",
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
  },
  engineDot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    flexShrink: 0,
  },
  tabLabel: { display: "inline-flex", alignItems: "center", gap: "4px" },
  tabCount: { flexShrink: 0, fontVariantNumeric: "tabular-nums", lineHeight: "1" },
  spacer: { flex: 1 },
  content: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  panel: {
    flex: 1,
    minHeight: 0,
    flexDirection: "column",
  },
  centered: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: tokens.colorNeutralForeground3,
    gap: "10px",
    flexDirection: "column",
  },
});

interface Props {
  tab: TableTab;
}

export function TableWorkspace({ tab }: Props) {
  const styles = useStyles();
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === tab.sessionId));
  const openQuery = useTabStore((s) => s.openQuery);
  const closeTab = useTabStore((s) => s.close);

  const [detail, setDetail] = useState<TableMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<TableView>(tab.view);
  // 已访问过的页签保持挂载，切换时不重新加载数据
  const [visited, setVisited] = useState<Set<TableView>>(() => new Set([tab.view]));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.tableDetail(
        tab.sessionId,
        tab.database,
        tab.table,
        tab.schema,
      );
      setDetail(result);
    } catch (err) {
      const message =
        typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [tab.database, tab.schema, tab.sessionId, tab.table]);

  useEffect(() => {
    setView(tab.view);
    setVisited(new Set([tab.view]));
    void load();
  }, [tab.id, load, tab.view]);

  const selectView = (next: TableView) => {
    setView(next);
    setVisited((current) => new Set(current).add(next));
  };

  const fullName = `${tab.database}${tab.schema ? `.${tab.schema}` : ""}.${tab.table}`;

  const openSelectQuery = () => {
    if (!session) return;
    openQuery(tab.sessionId, tab.database);
  };

  return (
    <div className={styles.root}>
      <div className={`${styles.header} dw-table-heading`}>
        {session && (
          <span
            className={styles.engineDot}
            style={{ backgroundColor: ENGINE_COLORS[session.engine] }}
          />
        )}
        <span className={styles.title}>{fullName}</span>
        {detail && (
          <Tag size="small" appearance="brand">
            {detail.kind === "view" ? "视图" : "表"}
          </Tag>
        )}
        <div className={styles.spacer} />

        <Button
          appearance="subtle"
          size="small"
          icon={<CodeRegular />}
          onClick={openSelectQuery}
        >
          新建查询
        </Button>
        <Button size="small" appearance="subtle" icon={<DataBarVerticalRegular/>} disabled={!session} title="新建独立分析，预填当前表的 SQL，不使用当前数据页或筛选" onClick={()=>{if(!session)return;const plan=newPlan(tab.sessionId,tab.database);plan.metadataSource={table:tab.table,schema:tab.schema??""};plan.name=(tab.table+" 分析").slice(0,120);plan.query="SELECT * FROM "+qualifiedTableSql(session.engine,tab.database,tab.schema,tab.table)+";";openAnalysis(plan);}}>新建分析</Button>
        <Button size="small" appearance="subtle" icon={<AddRegular/>} disabled={detail?.kind!=="table"} onClick={()=>window.dispatchEvent(new CustomEvent("dw:generation",{detail:{sessionId:tab.sessionId,database:tab.database,schema:tab.schema??null,object:tab.table}}))}>数据生成</Button>
        <Button
          appearance="subtle"
          size="small"
          icon={loading ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />}
          disabled={loading}
          onClick={async () => { if (await confirmEdits(e => e.tabId === tab.id)) await load(); }}
        >
          刷新
        </Button>
      </div>
      <TabList
        selectedValue={view}
        onTabSelect={(_, data) => selectView(data.value as TableView)}
        style={{ padding: "0 12px" }}
      >
        <Tab value="info" icon={<InfoRegular fontSize={14} />}>
          信息
        </Tab>
        <Tab value="data" icon={<GridRegular fontSize={14} />}>
          数据
        </Tab>
        <Tab value="structure" icon={<ColumnTripleRegular fontSize={14} />}>
          <span className={styles.tabLabel}><span>结构</span>
          {detail ? (
            <Badge className={styles.tabCount} size="small" appearance="tint">
              {detail.columns.length}
            </Badge>
          ) : null}
          </span>
        </Tab>
        <Tab value="indexes" icon={<ArrowSortRegular fontSize={14} />}>
          <span className={styles.tabLabel}><span>索引</span>
          {detail ? (
            <Badge className={styles.tabCount} size="small" appearance="tint">
              {detail.indexes.length}
            </Badge>
          ) : null}
          </span>
        </Tab>
        <Tab value="foreignKeys" icon={<LinkRegular fontSize={14} />}>
          <span className={styles.tabLabel}><span>外键</span>
          {detail ? (
            <Badge className={styles.tabCount} size="small" appearance="tint">
              {detail.foreignKeys.length}
            </Badge>
          ) : null}
          </span>
        </Tab>
        <Tab value="ddl" icon={<CodeRegular fontSize={14} />}>
          DDL
        </Tab>
      </TabList>
      <div className={styles.content}>
        {loading && !detail ? (
          <div className={styles.centered}>
            <Spinner label="加载表信息…" />
          </div>
        ) : error && !detail ? (
          <div className={styles.centered}>
            <span>{error}</span>
            <Button onClick={() => void load()}>重试</Button>
          </div>
        ) : detail && session ? (
          <>
            {visited.has("data") && (
              <div
                className={`${styles.panel} dw-enter`}
                style={{ display: view === "data" ? "flex" : "none" }}
              >
                <TableDataPanel
                  tab={tab}
                  detail={detail}
                  engine={session.engine}
                  readOnly={session.readOnly}
                  onChanged={() => void load()}
                />
              </div>
            )}
            {visited.has("structure") && (
              <div
                className={`${styles.panel} dw-enter`}
                style={{ display: view === "structure" ? "flex" : "none" }}
              >
                <ColumnsPanel
                  tab={tab}
                  detail={detail}
                  engine={session.engine}
                  readOnly={session.readOnly}
                  onChanged={() => void load()}
                  onDropped={() => closeTab(tab.id)}
                />
              </div>
            )}
            {visited.has("indexes") && (
              <div
                className={`${styles.panel} dw-enter`}
                style={{ display: view === "indexes" ? "flex" : "none" }}
              >
                <IndexesPanel
                  tab={tab}
                  detail={detail}
                  engine={session.engine}
                  readOnly={session.readOnly}
                  onChanged={() => void load()}
                />
              </div>
            )}
            {visited.has("foreignKeys") && (
              <div
                className={`${styles.panel} dw-enter`}
                style={{ display: view === "foreignKeys" ? "flex" : "none" }}
              >
                <ForeignKeysPanel
                  tab={tab}
                  detail={detail}
                  engine={session.engine}
                  readOnly={session.readOnly}
                  onChanged={() => void load()}
                />
              </div>
            )}
            {visited.has("ddl") && (
              <div
                className={`${styles.panel} dw-enter`}
                style={{ display: view === "ddl" ? "flex" : "none" }}
              >
                <DdlPanel detail={detail} engine={session.engine} />
              </div>
            )}
            {visited.has("info") && (
              <div
                className={`${styles.panel} dw-enter`}
                style={{ display: view === "info" ? "flex" : "none" }}
              >
                <InfoPanel tab={tab} onChanged={()=>void load()} />
              </div>
            )}
          </>
        ) : null}
        {session === undefined && (
          <div className={styles.centered}>会话已不存在，请关闭此页签</div>
        )}
      </div>
    </div>
  );
}
