import {
  Badge,
  Button,
  Spinner,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowClockwiseRegular,
  ChevronDownRegular,
  ChevronRightRegular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";
import type { InfoEntry } from "../../ipc/types";
import type { RedisTab } from "../../stores/useTabStore";
import { keyLabel, sectionLabel } from "./info-labels";

const DEFAULT_EXPANDED = new Set([
  "Server",
  "Clients",
  "Memory",
  "Persistence",
  "Stats",
  "Replication",
  "CPU",
  "Cluster",
  "Keyspace",
]);

const useStyles = makeStyles({
  wrap: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    padding: "10px 16px 28px",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "10px",
  },
  title: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
  },
  spacer: { flex: 1 },
  cards: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
    gap: "8px",
    marginBottom: "10px",
  },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "8px",
    padding: "7px 12px",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    background:
      "linear-gradient(180deg, color-mix(in srgb, var(--dw-accent) 7%, transparent), transparent 60%)",
  },
  cardLabel: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  cardValue: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    wordBreak: "break-all",
  },
  section: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "8px",
    overflow: "hidden",
    background: tokens.colorNeutralBackground1,
    marginBottom: "10px",
  },
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "5px 10px",
    background:
      "linear-gradient(90deg, color-mix(in srgb, var(--dw-accent) 14%, transparent), color-mix(in srgb, var(--dw-accent) 4%, transparent) 70%, transparent)",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    cursor: "pointer",
    userSelect: "none",
  },
  sectionTitle: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  sectionOriginal: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground4,
  },
  sectionCount: {
    marginLeft: "auto",
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground4,
  },
  entries: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))",
    gap: "0 16px",
    padding: "6px 10px 8px",
  },
  entry: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: "8px",
    alignItems: "baseline",
    fontSize: tokens.fontSizeBase200,
    lineHeight: "18px",
    borderBottom: `1px solid ${tokens.colorNeutralBackground3}`,
    padding: "1px 0",
  },
  entryKey: {
    color: tokens.colorNeutralForeground3,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  entryOriginal: {
    color: tokens.colorNeutralForeground4,
    fontSize: tokens.fontSizeBase100,
    marginLeft: "4px",
  },
  entryValue: {
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    fontSize: "11px",
    maxWidth: "150px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    userSelect: "text",
  },
  note: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  centered: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
});

function pick(entries: InfoEntry[], key: string): string | null {
  return entries.find((entry) => entry.key === key)?.value ?? null;
}

function formatValue(value: string): string {
  if (/^\d{5,}$/.test(value)) {
    return Number.parseInt(value, 10).toLocaleString("en-US");
  }
  return value;
}

interface Props {
  tab: RedisTab;
}

export function RedisOverview({ tab }: Props) {
  const styles = useStyles();
  const notify = useNotify();
  const [info, setInfo] = useState<InfoEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const entries = await api.redisServerInfo(tab.sessionId);
      setInfo(entries);
      const sections = [...new Set(entries.map((entry) => entry.section))];
      setCollapsed(new Set(sections.filter((section) => !DEFAULT_EXPANDED.has(section))));
    } catch (error) {
      notify.error(error, "读取 Redis 信息失败");
    } finally {
      setLoading(false);
    }
  }, [notify, tab.sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const sections = useMemo(() => {
    const groups = new Map<string, InfoEntry[]>();
    for (const entry of info) {
      const list = groups.get(entry.section) ?? [];
      list.push(entry);
      groups.set(entry.section, list);
    }
    return [...groups.entries()];
  }, [info]);

  const hits = Number(pick(info, "keyspace_hits") ?? "0");
  const misses = Number(pick(info, "keyspace_misses") ?? "0");
  const hitRate =
    hits + misses > 0 ? `${((hits / (hits + misses)) * 100).toFixed(1)}%` : "—";

  const cards: Array<{ label: string; value: string }> = [
    { label: "版本", value: pick(info, "redis_version") ?? "—" },
    { label: "模式", value: pick(info, "redis_mode") ?? "—" },
    { label: "运行时间", value: `${pick(info, "uptime_in_days") ?? "—"} 天` },
    { label: "客户端连接", value: pick(info, "connected_clients") ?? "—" },
    { label: "内存占用", value: pick(info, "used_memory_human") ?? "—" },
    { label: "最大内存", value: pick(info, "maxmemory_human") ?? "不限" },
    { label: "总连接数", value: pick(info, "total_connections_received") ?? "—" },
    { label: "缓存命中率", value: hitRate },
  ];

  const toggleSection = (section: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  if (loading && info.length === 0) {
    return (
      <div className={styles.centered}>
        <Spinner label="读取 Redis 服务器信息…" />
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <span className={styles.title}>Redis 概览</span>
        <Badge appearance="tint" color="brand" size="small">
          {pick(info, "redis_version") ?? "unknown"}
        </Badge>
        <div className={styles.spacer} />
        <Button
          size="small"
          appearance="subtle"
          disabled={loading}
          onClick={() => setCollapsed(new Set())}
        >
          展开全部
        </Button>
        <Button
          size="small"
          appearance="subtle"
          disabled={loading}
          onClick={() => setCollapsed(new Set(sections.map(([section]) => section)))}
        >
          折叠全部
        </Button>
        <Button
          size="small"
          appearance="subtle"
          icon={loading ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />}
          disabled={loading}
          onClick={() => void load()}
        >
          刷新
        </Button>
      </div>

      <div className={styles.cards}>
        {cards.map((card) => (
          <div key={card.label} className={styles.card}>
            <span className={styles.cardLabel}>{card.label}</span>
            <span className={styles.cardValue}>{card.value}</span>
          </div>
        ))}
      </div>

      {sections.map(([section, entries]) => {
        const isCollapsed = collapsed.has(section);
        const { label, original } = sectionLabel(section);
        return (
          <div key={section} className={styles.section}>
            <div className={styles.sectionHeader} onClick={() => toggleSection(section)}>
              {isCollapsed ? (
                <ChevronRightRegular fontSize={13} />
              ) : (
                <ChevronDownRegular fontSize={13} />
              )}
              <span className={styles.sectionTitle}>{label}</span>
              {original && <span className={styles.sectionOriginal}>{original}</span>}
              <span className={styles.sectionCount}>{entries.length} 项</span>
            </div>
            {!isCollapsed && (
              <div className={styles.entries}>
                {entries.map((entry) => {
                  const item = keyLabel(entry.key);
                  return (
                    <div key={entry.key} className={styles.entry}>
                      <span className={styles.entryKey} title={`${item.label}（${entry.key}）`}>
                        {item.label}
                        {item.original && (
                          <span className={styles.entryOriginal}>{item.original}</span>
                        )}
                      </span>
                      <span className={styles.entryValue} title={entry.value}>
                        {formatValue(entry.value)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
