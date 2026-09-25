import {TableOptionsEditor} from "./TableOptionsEditor";
import {
  Badge,
  Button,
  Spinner,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowClockwiseRegular,
  ClockRegular,
  ColumnTripleRegular,
  DatabaseRegular,
  InfoRegular,
  KeyRegular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useState } from "react";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";
import { formatBytes, type TableInfo } from "../../ipc/types";
import { useSessionStore } from "../../stores/useSessionStore";
import type { TableTab } from "../../stores/useTabStore";

const useStyles = makeStyles({
  wrap: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    padding: "var(--dw-panel-padding)",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "12px",
  },
  spacer: { flex: 1 },
  card: {
    maxWidth: "1100px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  section: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    columnGap: "24px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "8px",
    padding: "var(--dw-card-padding)",
    background:
      "linear-gradient(180deg, color-mix(in srgb, var(--dw-accent) 5%, transparent), transparent 45%)",
  },
  sectionTitle: {
    gridColumn: "1 / -1",
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground3,
    marginBottom: "6px",
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "100px minmax(0, 1fr)",
    gap: "10px",
    padding: "4px 0",
    alignItems: "start",
  },
  label: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  value: {
    minWidth: 0,
    overflowWrap: "anywhere",
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
    wordBreak: "break-word",
    userSelect: "text",
  },
  mono: {
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    fontSize: tokens.fontSizeBase200,
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
  centered: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
});

function valueText(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

interface RowProps {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}

function Row({ label, children, mono }: RowProps) {
  const styles = useStyles();
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span className={`${styles.value} ${mono ? styles.mono : ""}`}>{children}</span>
    </div>
  );
}

interface Props {
  tab: TableTab;
  onChanged?:()=>void;
}

export function InfoPanel({ tab,onChanged }: Props) {
  const styles = useStyles();
  const notify = useNotify();
  const engine = useSessionStore(
    (s) => s.sessions.find((item) => item.id === tab.sessionId)?.engine,
  );
  const [info, setInfo] = useState<TableInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setInfo(
        await api.tableInfo(tab.sessionId, tab.database, tab.table, tab.schema),
      );
    } catch (error) {
      notify.error(error, "加载表信息失败");
    } finally {
      setLoading(false);
    }
  }, [notify, tab.database, tab.schema, tab.sessionId, tab.table]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !info) {
    return (
      <div className={styles.centered}>
        <Spinner label="加载表信息…" />
      </div>
    );
  }

  if (!info) {
    return (
      <div className={styles.centered}>
        <Button onClick={() => void load()}>重试</Button>
      </div>
    );
  }

  const extra = info.extra;
  const isMysql = engine === "mysql";
  const isSqlite = engine === "sqlite";
  // 按引擎能力隐藏不适用的字段，避免显示误导性的占位符
  const showComment = engine === undefined || !isSqlite;
  const showRowEstimate = engine === undefined || !isSqlite;
  const showEngine = engine === undefined || !(engine === "postgres");
  const showCharset = isMysql;
  const showCollation = isMysql;
  const showTimes = isMysql;
  const showSize =
    (extra.totalSize !== null && extra.totalSize !== undefined) ||
    (extra.dataSize !== null && extra.dataSize !== undefined);
  const showStorage = showEngine || showCharset || showCollation || showSize;

  const autoIncrementParts: string[] = [];
  if (info.autoIncrementColumn) {
    autoIncrementParts.push(`列 ${info.autoIncrementColumn}`);
  }
  if (extra.autoIncrementValue !== null && extra.autoIncrementValue !== undefined) {
    autoIncrementParts.push(`下一个值 ${extra.autoIncrementValue}`);
  }

  return (
    <div className={`${styles.wrap} dw-table-info`}>
      <div className={styles.toolbar}>
        <Button
          appearance="subtle"
          size="small"
          icon={<ArrowClockwiseRegular />}
          onClick={() => void load()}
        >
          刷新
        </Button>
      </div>
      {info.kind==="table"&&<TableOptionsEditor key={JSON.stringify(info)} tab={tab} info={info} onSaved={()=>{void load();onChanged?.();}}/>}
      <div className={styles.card}>
        <div className={`${styles.section} dw-info-section`}>
          <div className={styles.sectionTitle}>
            <InfoRegular fontSize={14} />
            基本
          </div>
          <Row label="名称" mono>
            {info.name}
          </Row>
          <Row label="所属数据库" mono>
            {info.database}
          </Row>
          {info.schema && (
            <Row label="Schema" mono>
              {info.schema}
            </Row>
          )}
          <Row label="类型">
            <Badge appearance="tint" color="brand" size="small">
              {info.kind === "view" ? "视图" : "表"}
            </Badge>
          </Row>
          {showComment && (
            <Row label="注释">
              {info.comment ? (
                info.comment
              ) : (
                <span className={styles.muted}>—</span>
              )}
            </Row>
          )}
          {showRowEstimate && (
            <Row label="行数（估算）">
              {info.rowEstimate !== null && info.rowEstimate !== undefined
                ? info.rowEstimate.toLocaleString()
                : "—"}
            </Row>
          )}
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>
            <ColumnTripleRegular fontSize={14} />
            结构
          </div>
          <Row label="列数">{info.columnCount}</Row>
          <Row label="索引数">{info.indexCount}</Row>
          <Row label="外键数">{info.foreignKeyCount}</Row>
          <Row label="主键">
            {info.primaryKey.length > 0 ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <KeyRegular fontSize={12} />
                <span className={styles.mono}>{info.primaryKey.join(", ")}</span>
              </span>
            ) : (
              <span className={styles.muted}>无</span>
            )}
          </Row>
          <Row label="自增">
            {autoIncrementParts.length > 0 ? (
              <span className={styles.mono}>{autoIncrementParts.join(" · ")}</span>
            ) : (
              <span className={styles.muted}>—</span>
            )}
          </Row>
        </div>

        {showStorage && (
          <div className={styles.section}>
            <div className={styles.sectionTitle}>
              <DatabaseRegular fontSize={14} />
              存储
            </div>
            {showEngine && <Row label="引擎">{valueText(extra.engine)}</Row>}
            {showCharset && <Row label="字符集">{valueText(extra.charset)}</Row>}
            {showCollation && <Row label="排序规则">{valueText(extra.collation)}</Row>}
            {showSize && (
              <Row label="磁盘大小">
                {[
                  extra.totalSize != null ? `总 ${formatBytes(extra.totalSize)}` : null,
                  extra.dataSize != null ? `数据 ${formatBytes(extra.dataSize)}` : null,
                  extra.indexSize != null ? `索引 ${formatBytes(extra.indexSize)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Row>
            )}
          </div>
        )}

        {(extra.createdAt || extra.updatedAt || showTimes) && (
          <div className={styles.section}>
            <div className={styles.sectionTitle}>
              <ClockRegular fontSize={14} />
              时间
            </div>
            <Row label="创建时间">{valueText(extra.createdAt)}</Row>
            <Row label="更新时间">{valueText(extra.updatedAt)}</Row>
          </div>
        )}
      </div>
    </div>
  );
}
