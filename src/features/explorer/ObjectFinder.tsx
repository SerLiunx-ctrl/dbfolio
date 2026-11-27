import { Button, Dropdown, Input, Option, Spinner, tokens } from "@fluentui/react-components";
import { SearchRegular, StarRegular } from "@fluentui/react-icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../ipc";
import type { DatabaseMeta, TableRef } from "../../ipc/types";
import { useNotify } from "../../app/toast";
import { useExplorerStore } from "../../stores/useExplorerStore";
import { useTabStore } from "../../stores/useTabStore";
import { favoriteId, useObjectPreferences, type FavoriteObject } from "../../stores/useObjectPreferences";
import { useObjectNavigation } from "../../stores/useObjectNavigation";
import { FavoriteButton } from "./FavoriteButton";

interface Props {
  sessionId: string;
  redis: boolean;
  databases: readonly DatabaseMeta[];
  preferredDatabase?: string;
  visibilityControl?: ReactNode;
}

export function ObjectFinder({ sessionId, redis, databases, preferredDatabase, visibilityControl }: Props) {
  const notify = useNotify();
  const tables = useExplorerStore(state => state.tables);
  const favorites = useObjectPreferences(state => state.favorites);
  const [selectedScope, setSelectedScope] = useState(preferredDatabase ?? "");
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const sessionFavorites = favorites.filter(item => item.sessionId === sessionId);
  useEffect(() => {
    setSelectedScope(preferredDatabase ?? "");
  }, [preferredDatabase]);
  const database = databases.some(item => item.name === selectedScope)
    ? selectedScope
    : databases[0]?.name ?? "";
  const [query, setQuery] = useState("");
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const version = useRef(0);
  useEffect(() => {
    if (redis || !database || !query.trim() || tables[`tables:${sessionId}:${database}`]) return;
    void useExplorerStore.getState().loadTables(sessionId, database).catch(error => notify.error(error, "加载搜索范围失败"));
  }, [database, query, redis, sessionId, tables, notify]);
  const list = tables[`tables:${sessionId}:${database}`] ?? [];
  useEffect(() => { version.current++; setFields({}); setSearched(false); setBusy(false); return () => {version.current++;}; }, [database, query]);
  const open = (item: FavoriteObject) => {
    const tabs = useTabStore.getState();
    if (item.kind === "table") tabs.openTable({sessionId, database: item.database, table: item.name, schema: item.schema,objectKind:tables[`tables:${sessionId}:${item.database}`]?.find(t=>t.name===item.name&&(t.schema??null)===(item.schema??null))?.kind});
    else {
      tabs.openRedis(sessionId, item.database, item.database);
      const tabId = useTabStore.getState().activeId;
      if (tabId) useObjectNavigation.setState({request: {tabId, key: item.name}});
    }
  };
  const searchFields = async () => {
    const current = ++version.current;
    setBusy(true); setSearched(false);
    const found: Record<string, string[]> = {};
    let cursor = 0, failed = 0;
    await Promise.all([0, 1].map(async () => {
      while (cursor < list.length && current === version.current) {
        const table = list[cursor++];
        try {
          const detail = await api.tableDetail(sessionId, database, table.name, table.schema);
          found[JSON.stringify([table.schema, table.name])] = detail.columns.filter(column => `${column.name} ${column.comment ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())).map(column => column.name);
        } catch { failed++; }
      }
    }));
    if (current !== version.current) return;
    setFields(found); setBusy(false); setSearched(true);
    if (failed) notify.error(`有 ${failed} 张表的字段读取失败，搜索结果不完整。`, "字段搜索部分失败");
  };
  const matches = list.filter(table => `${table.schema ?? ""}.${table.name} ${table.comment ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()) || (fields[JSON.stringify([table.schema, table.name])]?.length ?? 0) > 0);
  const render = (item: FavoriteObject, extra?: string) => <div key={favoriteId(item)} style={{display:"flex",alignItems:"center",minWidth:0}}><Button appearance="subtle" size="small" style={{minWidth:0, flex:1, justifyContent:"flex-start",overflow:"hidden"}} title={`${item.database}.${item.schema ? item.schema+"." : ""}${item.name}${extra ? " · "+extra : ""}`} onClick={() => open(item)}><span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.database} · {item.schema ? item.schema+"." : ""}{item.name}{extra ? `（${extra}）` : ""}</span></Button><FavoriteButton item={item}/></div>;
  return <div style={{padding:"4px 10px", borderBottom:"1px solid var(--colorNeutralStroke2)",flexShrink:0}}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 4 }}>
      <Button appearance="subtle" size="small" icon={<StarRegular />} aria-expanded={favoritesOpen} onClick={() => setFavoritesOpen(value => !value)}>
        {sessionFavorites.length ? "收藏 · " + sessionFavorites.length : "收藏"}
      </Button>
      {redis && visibilityControl}
    </div>
    {favoritesOpen && <div style={{maxHeight:180,overflow:"auto"}}>{sessionFavorites.length ? sessionFavorites.map(item => render(item)) : <span style={{fontSize:12,color:tokens.colorNeutralForeground3}}>悬停对象并点击星标，即可添加收藏。</span>}</div>}
    {!redis && <>
    <div style={{display:"flex",gap:4,marginTop:4}}>
      <Input size="small" style={{minWidth:0,flex:1}} contentBefore={<SearchRegular/>} aria-label="搜索表名或注释" placeholder="搜索表名 / 注释" value={query} onChange={(_,data)=>setQuery(data.value)}/>
      {visibilityControl}
    </div>
    {!!query.trim() && (
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
        <span style={{ fontSize: 11, color: tokens.colorNeutralForeground3, whiteSpace: "nowrap" }}>搜索范围</span>
        <Dropdown
          size="small"
          style={{ minWidth: 0, flex: 1 }}
          aria-label="搜索数据库"
          placeholder="暂无可见数据库"
          value={database}
          selectedOptions={database ? [database] : []}
          disabled={!databases.length}
          onOptionSelect={(_, data) => setSelectedScope(data.optionValue ?? "")}
        >
          {databases.map(item => <Option value={item.name} key={item.name}>{item.name}</Option>)}
        </Dropdown>
      </div>
    )}
    {!!query.trim() && !!database && <><Button size="small" disabled={busy || !tables[`tables:${sessionId}:${database}`]} onClick={()=>void searchFields()}>同时搜索字段</Button>{busy && <Spinner size="tiny" label="搜索字段…"/>}<span style={{fontSize:11}}> {matches.length} 个匹配{searched ? "（含字段）" : ""}</span><div style={{maxHeight:220,overflow:"auto"}}>{matches.map((table:TableRef)=>render({sessionId,database,schema:table.schema,kind:"table",name:table.name},fields[JSON.stringify([table.schema,table.name])]?.join(", ")))}</div></>}
    </>}
  </div>;
}
