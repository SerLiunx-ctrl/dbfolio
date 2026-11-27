import { Button, Input, Spinner, tokens } from "@fluentui/react-components";
import { ArrowClockwiseRegular, DatabaseRegular, DocumentRegular, SearchRegular } from "@fluentui/react-icons";
import { useCallback, useEffect, useState } from "react";
import { ConnectionNotice } from "../../app/ConnectionNotice";
import { DockTitle } from "../../app/DockLayout";
import { useNotify } from "../../app/toast";
import { InfoHint } from "../../common/InfoHint";
import type { SessionRecord } from "../../ipc/types";
import { databasesKey, useExplorerStore } from "../../stores/useExplorerStore";
import { loadExplorerDatabaseVisibility, useExplorerVisibility } from "../../stores/useExplorerVisibility";
import { useObjectPreferences } from "../../stores/useObjectPreferences";
import { useSessionStore } from "../../stores/useSessionStore";
import { useTabStore } from "../../stores/useTabStore";
import { DatabaseVisibilityButton } from "../explorer/DatabaseVisibilityButton";
import { FavoriteButton } from "../explorer/FavoriteButton";
import { mongo } from "./api";

interface CollectionResult {
  database: string;
  revision: number;
  names: string[];
}

export function MongoExplorer({ session }: { session: SessionRecord }) {
  const notify = useNotify();
  const connected = useSessionStore(s => s.statuses[session.id]?.connected ?? false);
  const databases = useExplorerStore(s => s.databases[session.id]);
  const databasesBusy = useExplorerStore(s => Boolean(s.loading[databasesKey(session.id)]));
  const loadDatabases = useExplorerStore(s => s.loadDatabases);
  const hiddenDatabases = useExplorerVisibility(s => s.hiddenDatabases[session.id]);
  const favorites = useObjectPreferences(s => s.favorites).filter(f => f.sessionId === session.id && f.kind === "mongo");
  const [selectedDatabase, setSelectedDatabase] = useState(session.database ?? "");
  const [collectionResult, setCollectionResult] = useState<CollectionResult | null>(null);
  const [revision, setRevision] = useState(0);
  const [visibilityLoaded, setVisibilityLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [manualName, setManualName] = useState("");

  const databaseNames = databases?.map(database => database.name) ?? [];
  const visibleDatabases = databaseNames.filter(name => !hiddenDatabases?.includes(name));
  const database = visibilityLoaded
    ? (visibleDatabases.includes(selectedDatabase) ? selectedDatabase : visibleDatabases[0] ?? "")
    : "";
  const hasCurrentResult = collectionResult?.database === database && collectionResult.revision === revision;
  const collections = hasCurrentResult ? collectionResult.names : [];
  const collectionsBusy = Boolean(database) && !hasCurrentResult;
  const matchingCollections = collections.filter(name => name.toLowerCase().includes(search.toLowerCase()));

  const refreshDatabases = useCallback(() => {
    void loadDatabases(session.id).catch(error => notify.error(error, "读取数据库失败"));
  }, [loadDatabases, notify, session.id]);

  useEffect(() => {
    if (connected && !databases) refreshDatabases();
  }, [connected, databases, refreshDatabases]);

  useEffect(() => {
    if (!connected) return;
    let active = true;
    const ready = () => { if (active) setVisibilityLoaded(true); };
    void loadExplorerDatabaseVisibility().then(ready, ready);
    return () => { active = false; };
  }, [connected]);

  useEffect(() => {
    if (visibilityLoaded && databases) setSelectedDatabase(database);
  }, [database, databases, visibilityLoaded]);

  useEffect(() => {
    if (!connected || !database) {
      setCollectionResult(null);
      return;
    }
    let active = true;
    void mongo.collections(session.id, database).then(names => {
      if (active) setCollectionResult({ database, revision, names: [...names].sort() });
    }).catch(error => {
      if (!active) return;
      setCollectionResult({ database, revision, names: [] });
      notify.error(error, "读取集合失败");
    });
    return () => { active = false; };
  }, [connected, database, notify, revision, session.id]);

  const open = (db: string, name: string) => useTabStore.getState().openMongo(session.id, db, name);

  return (
    <section className="dw-mongo-explorer">
      <header>
        <DockTitle panel="explorer">对象浏览器</DockTitle>
        <Button
          size="small"
          appearance="subtle"
          icon={<ArrowClockwiseRegular />}
          aria-label="刷新集合"
          disabled={!connected || databasesBusy}
          onClick={() => {
            refreshDatabases();
            setRevision(value => value + 1);
          }}
        />
      </header>
      {!connected ? <ConnectionNotice sessionId={session.id} standalone /> : <>
        <div style={{ padding: 8, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8 }}>
          <label>
            <DatabaseRegular aria-hidden="true" /> 数据库
            <select
              className="dw-native-select"
              style={{ width: "100%" }}
              value={database}
              disabled={!database}
              onChange={event => setSelectedDatabase(event.target.value)}
            >
              {!database && <option value="">无可见数据库</option>}
              {visibleDatabases.map(name => <option key={name}>{name}</option>)}
            </select>
          </label>
          <div style={{ display: "flex", gap: 4 }}>
            <Input
              size="small"
              style={{ minWidth: 0, flex: 1 }}
              contentBefore={<SearchRegular />}
              aria-label="搜索集合"
              placeholder="搜索集合"
              value={search}
              disabled={!database}
              onChange={(_, data) => setSearch(data.value)}
            />
            <DatabaseVisibilityButton
              sessionId={session.id}
              databases={databaseNames}
              busy={databasesBusy}
              onRefresh={refreshDatabases}
            />
          </div>
        </div>
        <div style={{ display: "flex", padding: 8, gap: 6 }}>
          <Input
            aria-label="集合名称"
            placeholder="输入集合名"
            value={manualName}
            disabled={!database}
            onChange={(_, data) => setManualName(data.value)}
            style={{ minWidth: 0, flex: 1 }}
          />
          <Button disabled={!database || !manualName.trim()} onClick={() => open(database, manualName.trim())}>打开</Button>
        </div>
        <InfoHint label="打开集合说明">可按名称打开集合；新集合在首次保存文档后创建。</InfoHint>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          {favorites.length > 0 && (
            <details>
              <summary>收藏（{favorites.length}）</summary>
              {favorites.map(favorite => (
                <div className="dw-mongo-object" key={favorite.database + "/" + favorite.name}>
                  <Button appearance="subtle" onClick={() => open(favorite.database, favorite.name)}>
                    {favorite.database}.{favorite.name}
                  </Button>
                  <FavoriteButton item={favorite} />
                </div>
              ))}
            </details>
          )}
          {collectionsBusy && <Spinner size="tiny" label="读取集合" />}
          {matchingCollections.map(name => (
            <div className="dw-mongo-object" key={name}>
              <Button
                appearance="subtle"
                icon={<DocumentRegular />}
                style={{ flex: 1, minWidth: 0, justifyContent: "start", overflow: "hidden" }}
                title={name}
                onClick={() => open(database, name)}
              >
                {name}
              </Button>
              <FavoriteButton item={{ kind: "mongo", sessionId: session.id, database, name }} />
            </div>
          ))}
          {database && !collectionsBusy && !collections.length && (
            <p style={{ padding: 12, color: tokens.colorNeutralForeground3 }}>当前数据库没有可见集合</p>
          )}
          {!database && (databasesBusy || !visibilityLoaded ? <Spinner size="tiny" label="读取数据库" /> : (
            <p style={{ padding: 12, color: tokens.colorNeutralForeground3 }}>
              {databaseNames.length ? "所有数据库都已隐藏，可从数据库显隐恢复。" : "没有可用数据库"}
            </p>
          ))}
        </div>
      </>}
    </section>
  );
}
