import {InfoHint} from '../../common/InfoHint';
import {SchemaPlanDialog} from "./SchemaPlanDialog";
import {SourceFilters} from './SourceFilters';
import type {SourceFilter} from './model';
import {useTabStore,type SyncTab} from '../../stores/useTabStore';
import {usePendingEdit} from '../../stores/useEditGuard';
import {useTaskStore,isTaskActive} from '../../stores/useTaskStore';
import { TaskActivity } from "../../app/TaskActivity";
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Badge,
  Button,
  Checkbox,
  Dropdown,
  Field,
  Input,
  Option,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Tag,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  ArrowClockwiseRegular,
  ArrowLeftRegular,
  ArrowSwapRegular,
  PlayRegular,
} from "@fluentui/react-icons";
import { useEffect,useState } from "react";
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";
import type {
  DataSyncOptions,
  DatabaseMeta,
  SchemaCompareResult,
  SchemaSyncOptions,
  SyncEndpoint,
  SyncStatement,
  TableDataDiff,
  TableRef,
} from "../../ipc/types";
import { useSessionStore } from "../../stores/useSessionStore";
import { ConfirmSqlDialog } from "../table/ConfirmSqlDialog";
import { ENGINE_LABELS } from "../sessions/engine";

const useStyles = makeStyles({
  root: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  steps: {
    display: "flex",
    alignItems: "center",
    gap: "16px",
    padding: "10px 16px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    flexShrink: 0,
  },
  step: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  stepActive: {
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  content: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    padding: "var(--dw-panel-padding)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--dw-section-gap)",
  },
  cards: {
    display: "grid",
    gridTemplateColumns: "1fr auto 1fr",
    gap: "12px",
    alignItems: "end",
    maxWidth: "980px",
  },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "8px",
    padding: "12px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  cardTitle: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  tableList: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "8px",
    maxHeight: "420px",
    overflow: "auto",
    padding: "6px 10px",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    maxWidth: "720px",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
  },
  spacer: { flex: 1 },
  options: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "10px 24px",
    maxWidth: "860px",
  },
  optionGroup: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    fontSize: tokens.fontSizeBase200,
  },
  diffCard: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "8px",
    padding: "10px 14px",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    maxWidth: "980px",
  },
  diffTitle: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  diffLine: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    fontFamily: '"Cascadia Mono", Consolas, monospace',
  },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  log: {
    margin: 0,
    padding: "10px 12px",
    borderRadius: "6px",
    backgroundColor: tokens.colorNeutralBackground3,
    fontSize: tokens.fontSizeBase200,
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    whiteSpace: "pre-wrap",
    maxHeight: "220px",
    overflow: "auto",
    userSelect: "text",
  },
});

const STATUS_LABEL: Record<string, string> = {
  same: "一致",
  different: "有差异",
  onlySource: "仅源存在",
  onlyTarget: "仅目标存在",
  missing: "缺失",
};

export function SyncWorkspace({tab,active=true}:{tab?:SyncTab;active?:boolean}) {
  const draft=tab?.draft;
  const styles = useStyles();
  const notify = useNotify();
  const sessions = useSessionStore((s) => s.sessions);
  const statuses = useSessionStore((s) => s.statuses);
  const connectedSessions = sessions.filter(
    (session) => statuses[session.id]?.connected && session.engine !== "redis" && session.engine !== "mongodb",
  );

  const [step, setStep] = useState(0);
  const [sourceSession, setSourceSession] = useState(draft?.sourceSession??"");
  const [sourceDb, setSourceDb] = useState(draft?.sourceDb??"");
  const [targetSession, setTargetSession] = useState(draft?.targetSession??"");
  const [targetDb, setTargetDb] = useState(draft?.targetDb??"");
  const [sourceDbs, setSourceDbs] = useState<DatabaseMeta[]>([]);
  const [targetDbs, setTargetDbs] = useState<DatabaseMeta[]>([]);
  const [search,setSearch]=useState('');
  const [tables, setTables] = useState<TableRef[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set(draft?.selected??[]));
  const [loading, setLoading] = useState("");
  const [schemaDiff, setSchemaDiff] = useState<SchemaCompareResult | null>(null);
  const [detailDiff,setDetailDiff]=useState<TableDataDiff|null>(null);
  const [dataDiff, setDataDiff] = useState<TableDataDiff[] | null>(null);
  const [preview, setPreview] = useState<{ title: string; lines: string[] } | null>(null);
  const [pendingSchema, setPendingSchema] = useState(false);
  const [pendingData, setPendingData] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [schemaOptions, setSchemaOptions] = useState<SchemaSyncOptions>(draft?.schemaOptions??{
    createMissingTables: true,
    dropMissingTables: false,
    addMissingColumns: true,
    alterChangedColumns: true,
    dropExtraColumns: false,
    createIndexes: true,
    createForeignKeys: true,
  });
  const [dataOptions, setDataOptions] = useState<DataSyncOptions>(draft?.dataOptions??{
    insertMissing: true,
    updateChanged: true,
    deleteExtra: false,
    batchSize: 500,
    continueOnError: false,
  });

  const [filters,setFilters]=useState<Record<string,SourceFilter>>(draft?.filters??{});
  const activeTasks=useTaskStore(s=>s.tasks).filter(t=>tab&&t.tabId===tab.id&&isTaskActive(t));
  const busy=!!loading||activeTasks.length>0;
  usePendingEdit({tabId:tab?.id??"sync-standalone",sessionId:"",label:"数据同步",busy:()=>busy,save:async()=>{},discard:()=>{}},busy);
  useEffect(()=>{if(tab)useTabStore.getState().updateSync(tab.id,{sourceSession,sourceDb,targetSession,targetDb,selected:[...selected],schemaOptions,dataOptions,filters});},[sourceSession,sourceDb,targetSession,targetDb,selected,schemaOptions,dataOptions,filters,tab?.id]);
  useEffect(()=>{if(draft?.sourceSession)void loadDatabases(draft.sourceSession,"source");if(draft?.targetSession)void loadDatabases(draft.targetSession,"target");},[]);
  const selectedFilters=Object.fromEntries(Object.entries(filters).filter(([t])=>selected.has(t)));
  const hasFilters=Object.values(selectedFilters).some(f=>f.conditions.length>0);
  const changeFilters=(value:Record<string,SourceFilter>)=>{setFilters(value);setDataDiff(null);if(Object.values(value).some(f=>f.conditions.length))setDataOptions(v=>({...v,deleteExtra:false}));};
  const sourceMeta = sessions.find((session) => session.id === sourceSession);
  const targetMeta = sessions.find((session) => session.id === targetSession);
  const enginesMatch =
    !sourceMeta || !targetMeta || sourceMeta.engine === targetMeta.engine;
  const readyForStep2 =
    sourceSession &&
    sourceDb &&
    targetSession &&
    targetDb &&
    enginesMatch &&
    !(sourceSession === targetSession && sourceDb === targetDb);

  const selectedTables = tables
    .filter((table) => selected.has(table.name))
    .map((table) => table.name);

  const visibleTables=tables.filter(table=>(table.name+' '+(table.comment??'')).toLowerCase().includes(search.toLowerCase()));
  const sourceEndpoint = (): SyncEndpoint => ({
    sessionId: sourceSession,
    database: sourceDb,
  });
  const targetEndpoint = (): SyncEndpoint => ({
    sessionId: targetSession,
    database: targetDb,
  });

  const loadDatabases = async (sessionId: string, target: "source" | "target") => {
    setLoading(`dbs-${target}`);
    try {
      const databases = await api.listDatabases(sessionId);
      if (target === "source") {
        setSourceDbs(databases);
        setSourceDb((current) => (current ? current : databases[0]?.name ?? ""));
      } else {
        setTargetDbs(databases);
        setTargetDb((current) => (current ? current : databases[0]?.name ?? ""));
      }
    } catch (error) {
      notify.error(error, "加载数据库列表失败");
    } finally {
      setLoading("");
    }
  };

  const loadTables = async () => {
    setLoading("tables");
    try {
      const [sourceTables, targetTables] = await Promise.all([api.listTables(sourceSession, sourceDb), api.listTables(targetSession, targetDb)]);
      const onlyTables = [...new Map([...targetTables, ...sourceTables].filter(t=>t.kind==="table").map(t=>[t.name,t])).values()].sort((a,b)=>a.name.localeCompare(b.name));
      setSchemaOptions(o=>({...o,excludedChanges:[]}));
      setTables(onlyTables);
      setSelected(current=>new Set(onlyTables.filter(t=>current.has(t.name)).map(t=>t.name)));
      setSearch('');
      setStep(1);
      setSchemaDiff(null);
      setDataDiff(null);
    } catch (error) {
      notify.error(error, "加载数据表失败");
    } finally {
      setLoading("");
    }
  };

  const compareSchema = async () => {
    setLoading("schema");
    try {
      const result = await api.syncCompareSchema(
        sourceEndpoint(),
        targetEndpoint(),
        selectedTables,tab?.id,
      );
      setSchemaDiff(result);
      appendLog(
        `结构对比完成：需建表 ${result.summary.createTables}，需改表 ${result.summary.alterTables}，一致 ${result.summary.sameTables}，仅目标存在 ${result.summary.dropTables}`,
      );
    } catch (error) {
      notify.error(error, "结构对比失败");
    } finally {
      setLoading("");
    }
  };

  const compareData = async () => {
    setLoading("data");
    try {
      const result = await api.syncCompareData({
        source: sourceEndpoint(),
        target: targetEndpoint(),
        tables: selectedTables,
        options: dataOptions,

        filters:selectedFilters,},tab?.id);
      setDataDiff(result);
      appendLog(
        `数据对比完成：${result.length} 张表，累计待插入 ${result.reduce((sum, item) => sum + item.inserts, 0)}，待更新 ${result.reduce((sum, item) => sum + item.updates, 0)}`,
      );
    } catch (error) {
      notify.error(error, "数据对比失败");
    } finally {
      setLoading("");
    }
  };

  const appendLog = (line: string) => {
    setLogLines((current) => [
      ...current.slice(-200),
      `[${new Date().toLocaleTimeString()}] ${line}`,
    ]);
  };

  const openSchemaPreview = async () => {
    setLoading("schema-preview");
    try {
      const plan = await api.syncPreviewSchema({
        source: sourceEndpoint(),
        target: targetEndpoint(),
        tables: selectedTables,
        options: schemaOptions,
      },tab?.id);
      setPreview({
        title: `结构同步脚本（${plan.statements.length} 条）`,
        lines: [...plan.warnings.map(w => `-- 未自动处理：${w}`), ...plan.statements.map(
          (statement: SyncStatement) =>
            statement.sql || `-- ${statement.description}（无法自动执行）`,
        )],
      });
    } catch (error) {
      notify.error(error, "生成脚本失败");
    } finally {
      setLoading("");
    }
  };


  const includeChange = (table: string, kind: string, name: string, label: string) => {
    const key=JSON.stringify([table,kind,name]);
    return <Checkbox size="medium" label={label} checked={!schemaOptions.excludedChanges?.includes(key)} onChange={(_,d)=>setSchemaOptions({...schemaOptions,excludedChanges:d.checked?(schemaOptions.excludedChanges??[]).filter(k=>k!==key):[...new Set([...(schemaOptions.excludedChanges??[]),key])]})}/>;
  };
  const mysqlSchema = sessions.find(s=>s.id===sourceSession)?.engine === "mysql";

  return (
    <div className={styles.root}>
      <TaskActivity kind="同步" tabId={tab?.id} />
      <div className={styles.steps}>
        {["① 选择端点", "② 选择对象", "③ 对比与执行"].map((label, index) => (
          <span
            key={label}
            className={`${styles.step} ${index === step ? styles.stepActive : ""}`}
          >
            {label}
          </span>
        ))}
        <div className={styles.spacer} /><Button size="small" onClick={()=>useTabStore.getState().openSync()}>新建同步页</Button>
        {loading && <Spinner size="tiny" />}
      </div>

      <fieldset disabled={busy||pendingSchema||pendingData} className={styles.content} style={{border:0,margin:0,minWidth:0}}>
        {step === 0 && (
          <>
            <div className={styles.cards}>
              <div className={styles.card}>
                <span className={styles.cardTitle}>源（读取）</span>
                <Field label="会话" required>
                  <Dropdown
                    disabled={loading!==""}
                    selectedOptions={[sourceSession]}
                    value={sourceMeta ? sourceMeta.name : "选择已连接的会话"}
                    onOptionSelect={(_, data) => {
                      if (data.optionValue) {
                        setSelected(new Set());setFilters({});setSourceSession(data.optionValue);
                        setSourceDb("");
                        setSourceDbs([]);
                        void loadDatabases(data.optionValue, "source");
                      }
                    }}
                  >
                    {connectedSessions.map((session) => (
                      <Option
                        key={session.id}
                        value={session.id}
                        text={`${session.name}（${ENGINE_LABELS[session.engine]}）`}
                      >
                        {session.name}（{ENGINE_LABELS[session.engine]}）
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="数据库" required>
                  <Dropdown
                    disabled={loading!==""}
                    selectedOptions={[sourceDb]}
                    value={sourceDb || "选择数据库"}
                    onOptionSelect={(_, data) => {
                      if (data.optionValue) {setSelected(new Set());setFilters({});setSourceDb(data.optionValue);}
                    }}
                  >
                    {sourceDbs.map((database) => (
                      <Option key={database.name} value={database.name}>
                        {database.name}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              </div>
              <ArrowSwapRegular fontSize={20} />
              <div className={styles.card}>
                <span className={styles.cardTitle}>目标（写入）</span>
                <Field label="会话" required>
                  <Dropdown
                    disabled={loading!==""}
                    selectedOptions={[targetSession]}
                    value={targetMeta ? targetMeta.name : "选择已连接的会话"}
                    onOptionSelect={(_, data) => {
                      if (data.optionValue) {
                        setTargetSession(data.optionValue);
                        setTargetDb("");
                        setTargetDbs([]);
                        void loadDatabases(data.optionValue, "target");
                      }
                    }}
                  >
                    {connectedSessions.map((session) => (
                      <Option
                        key={session.id}
                        value={session.id}
                        text={`${session.name}（${ENGINE_LABELS[session.engine]}）`}
                      >
                        {session.name}（{ENGINE_LABELS[session.engine]}）
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="数据库" required>
                  <Dropdown
                    disabled={loading!==""}
                    selectedOptions={[targetDb]}
                    value={targetDb || "选择数据库"}
                    onOptionSelect={(_, data) => {
                      if (data.optionValue) setTargetDb(data.optionValue);
                    }}
                  >
                    {targetDbs.map((database) => (
                      <Option key={database.name} value={database.name}>
                        {database.name}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              </div>
            </div>
            {!enginesMatch && (
              <div className={styles.muted}>
                源与目标的数据库类型不一致，首版仅支持同引擎同步。
              </div>
            )}
            {connectedSessions.length < 2 && (
              <div className={styles.muted}>
                请先连接源和目标会话；同一会话下可选择不同数据库。
              </div>
            )}
            <div className={styles.toolbar}>
              <Button
                appearance="primary"
                disabled={!readyForStep2 || loading !== ""}
                onClick={() => void loadTables()}
              >
                下一步：选择对象
              </Button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <div className={styles.toolbar}>
              <Button
                appearance="subtle"
                size="small"
                icon={<ArrowLeftRegular />}
                onClick={() => setStep(0)}
              >
                上一步
              </Button>
              <span className={styles.muted}>
                {sourceDb} → {targetDb}，共 {tables.length} 张表，已选 {selected.size} 张
              </span>
              <div className={styles.spacer} />
              <Button
                appearance="subtle"
                size="small"
                onClick={() => setSelected(current=>new Set([...current,...visibleTables.map(table=>table.name)]))}
              >
                选择筛选结果
              </Button>
              <Button appearance="subtle" size="small" onClick={() => setSelected(new Set())}>
                全不选
              </Button>
            </div>
            <Input size="small" aria-label="搜索同步表" placeholder="搜索表名 / 备注" value={search} onChange={(_,data)=>setSearch(data.value)}/>
            <InfoHint label="同步范围说明">勾选需要同步的表；结构和数据均只处理所选范围。可先同步结构，再同步数据。</InfoHint>
            <div className={styles.tableList}>
              {visibleTables.map((table) => (
                <Checkbox
                  key={table.name}
                  label={table.name+(table.comment?" · "+table.comment:"")}
                  checked={selected.has(table.name)}
                  onChange={(_, data) => {
                    setSelected((current) => {
                      const next = new Set(current);
                      if (data.checked) next.add(table.name);
                      else next.delete(table.name);
                      return next;
                    });
                  }}
                />
              ))}
              {visibleTables.length === 0 && <span className={styles.muted}>没有匹配的可同步表</span>}
            </div>
            <div className={styles.toolbar}>
              <Button
                appearance="primary"
                disabled={selected.size === 0}
                onClick={() => {setSchemaDiff(null);setDataDiff(null);setStep(2);}}
              >
                下一步：对比与执行
              </Button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className={styles.toolbar}>
              <Button
                appearance="subtle"
                size="small"
                icon={<ArrowLeftRegular />}
                disabled={loading!==""}
                onClick={() => {setSchemaDiff(null);setDataDiff(null);setStep(1);}}
              >
                上一步
              </Button>
              <span className={styles.muted}>
                源 {sourceDb} → 目标 {targetDb}，已选 {selected.size} 张表：{selectedTables.join("、")}
              </span>
              <div className={styles.spacer} />
              <Button
                size="small"
                icon={<ArrowClockwiseRegular />}
                disabled={loading !== "" || selectedTables.length===0}
                onClick={() => void compareSchema()}
              >
                结构对比
              </Button>
              <Button
                size="small"
                icon={<ArrowClockwiseRegular />}
                disabled={loading !== "" || selectedTables.length===0}
                onClick={() => void compareData()}
              >
                数据对比
              </Button>
            </div>

            <SourceFilters sessionId={sourceSession} database={sourceDb} tables={selectedTables} filters={selectedFilters} disabled={busy} onChange={changeFilters}/>
            <div className={styles.options}>
              <div className={styles.optionGroup}>
                <span className={styles.cardTitle}>结构选项</span>
                <Checkbox
                  label="创建目标缺失的表"
                  checked={schemaOptions.createMissingTables}
                  onChange={(_, data) =>
                    setSchemaOptions({ ...schemaOptions, createMissingTables: Boolean(data.checked) })
                  }
                />
                <Checkbox
                  label="添加缺失的列"
                  checked={schemaOptions.addMissingColumns}
                  onChange={(_, data) =>
                    setSchemaOptions({ ...schemaOptions, addMissingColumns: Boolean(data.checked) })
                  }
                />
                <Checkbox
                  label="修改有差异的列（类型/可空/默认值）"
                  checked={schemaOptions.alterChangedColumns}
                  onChange={(_, data) =>
                    setSchemaOptions({ ...schemaOptions, alterChangedColumns: Boolean(data.checked) })
                  }
                />
                <Checkbox
                  label="创建 / 更新索引"
                  checked={schemaOptions.createIndexes}
                  onChange={(_, data) =>
                    setSchemaOptions({ ...schemaOptions, createIndexes: Boolean(data.checked) })
                  }
                />
                <Checkbox
                  label="创建 / 更新外键"
                  checked={schemaOptions.createForeignKeys}
                  onChange={(_, data) =>
                    setSchemaOptions({ ...schemaOptions, createForeignKeys: Boolean(data.checked) })
                  }
                />
                {([
                  ["syncPrimaryKey", "同步主键（MySQL）"],
                  ["syncTableOptions", "同步表注释 / 引擎 / 字符集（MySQL）"],
                  ["dropExtraIndexes", "删除目标多余索引（MySQL）"],
                  ["dropExtraForeignKeys", "删除目标多余外键（MySQL）"],
                ] as const).map(([key, label]) => <Checkbox key={key} label={label} checked={Boolean(schemaOptions[key])} onChange={(_, data) => setSchemaOptions({...schemaOptions, [key]: Boolean(data.checked)})} />)}
                <Checkbox
                  label="删除目标多余的列（危险）"
                  checked={schemaOptions.dropExtraColumns}
                  onChange={(_, data) =>
                    setSchemaOptions({ ...schemaOptions, dropExtraColumns: Boolean(data.checked) })
                  }
                />
                <Checkbox
                  label="删除目标多余的表（危险）"
                  checked={schemaOptions.dropMissingTables}
                  onChange={(_, data) =>
                    setSchemaOptions({ ...schemaOptions, dropMissingTables: Boolean(data.checked) })
                  }
                />
              </div>
              <div className={styles.optionGroup}>
                <span className={styles.cardTitle}>数据选项</span>
                <Checkbox
                  label="插入目标缺失的行"
                  checked={dataOptions.insertMissing}
                  onChange={(_, data) =>
                    setDataOptions({ ...dataOptions, insertMissing: Boolean(data.checked) })
                  }
                />
                <Checkbox
                  label="更新有差异的行（以源为准）"
                  checked={dataOptions.updateChanged}
                  onChange={(_, data) =>
                    setDataOptions({ ...dataOptions, updateChanged: Boolean(data.checked) })
                  }
                />
                <Checkbox
                  disabled={hasFilters}
                  label={hasFilters?"源数据筛选模式不删除目标其他行":"删除目标多余的行（危险）"}
                  checked={dataOptions.deleteExtra}
                  onChange={(_, data) =>
                    setDataOptions({ ...dataOptions, deleteExtra: Boolean(data.checked) })
                  }
                />
                <Checkbox
                  label="出错继续执行"
                  checked={dataOptions.continueOnError}
                  onChange={(_, data) =>
                    setDataOptions({ ...dataOptions, continueOnError: Boolean(data.checked) })
                  }
                />
                <InfoHint label="同步批次说明">
                  数据同步按主键分批（默认 500 行/批）执行；无主键表跳过。
                </InfoHint>
              </div>
            </div>

            <div className={styles.toolbar}>
              <Button size="small" disabled={loading !== "" || selectedTables.length===0} onClick={() => void openSchemaPreview()}>
                预览结构脚本
              </Button>
              <Button
                appearance="primary"
                size="small"
                icon={<PlayRegular />}
                disabled={loading !== "" || selectedTables.length===0 || targetMeta?.readOnly}
                title={targetMeta?.readOnly?"目标会话为只读，可比较和预览，不能写入":undefined}
                onClick={() => setPendingSchema(true)}
              >
                执行结构同步
              </Button>
              <Button
                appearance="primary"
                size="small"
                icon={<PlayRegular />}
                disabled={loading !== "" || selectedTables.length===0 || targetMeta?.readOnly}
                title={targetMeta?.readOnly?"目标会话为只读，可比较和预览，不能写入":undefined}
                onClick={() => setPendingData(true)}
              >
                执行数据同步
              </Button>
            </div>

            {schemaDiff && (
              <div className={styles.diffCard}>
                <div className={styles.diffTitle}>
                  结构差异
                  <Badge appearance="tint" color="informative">
                    建表 {schemaDiff.summary.createTables}
                  </Badge>
                  <Badge appearance="tint" color="warning">
                    改表 {schemaDiff.summary.alterTables}
                  </Badge>
                  <Badge appearance="tint" color="brand">
                    一致 {schemaDiff.summary.sameTables}
                  </Badge>
                </div>
                {schemaDiff.tables
                  .filter((table) => table.status !== "same")
                  .map((table) => (
                    <div key={table.table} className={styles.diffLine}>
                      <Tag size="small" appearance="brand">
                        {STATUS_LABEL[table.status] ?? table.status}
                      </Tag>{" "}
                      {table.table}
                      {table.details?.map((detail, i) => <div key={i} style={{marginLeft:16}}>{mysqlSchema ? includeChange(table.table,detail.startsWith("主键")?"primary":"tableOptions","",detail) : detail}</div>)}
                      {[...table.indexes.map(i=>({...i,label:"索引"})),...table.foreignKeys.map(i=>({...i,label:"外键"}))].filter(i=>i.status!=="same").map(i=><div key={i.label+i.name} style={{marginLeft:16}}>{mysqlSchema && table.status==="different" ? includeChange(table.table,i.label==="索引"?"index":"foreignKey",i.name,`${i.label} ${i.name}：${STATUS_LABEL[i.status] ?? i.status}（${i.definition}）`) : `${i.label} ${i.name}：${STATUS_LABEL[i.status] ?? i.status}（${i.definition}）`}</div>)}
                      {table.status === "onlySource" && " → 将在目标创建"}
                      {table.status === "onlyTarget" && " → 仅目标存在"}
                      {table.status !== "onlySource" &&
                        table.status !== "onlyTarget" &&
                        table.columns
                          .filter((column) => column.status !== "same")
                                                    .map((column) => (
                            <div key={column.name} style={{ marginLeft: 16 }}>
                              {mysqlSchema ? includeChange(table.table,"column",column.name,`${column.name}：${column.details.join("；")}`) : `${column.name}：${column.details.join("；")}`}
                              {column.sourceType ? `（源 ${column.sourceType}` : ""}
                              {column.targetType ? ` / 目标 ${column.targetType}）` : column.sourceType ? "）" : ""}
                            </div>
                          ))}
                    </div>
                  ))}
                {schemaDiff.tables.every((table) => table.status === "same") && (
                  <span className={styles.muted}>已检查的结构属性一致</span>
                )}
              </div>
            )}

            {dataDiff && (
              <div className={styles.diffCard}>
                <div className={styles.diffTitle}>数据差异</div>
                <Table size="extra-small">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>表</TableHeaderCell>
                      <TableHeaderCell>源行数</TableHeaderCell>
                      <TableHeaderCell>目标行数</TableHeaderCell>
                      <TableHeaderCell>待插入</TableHeaderCell>
                      <TableHeaderCell>待更新</TableHeaderCell>
                      <TableHeaderCell>待删除</TableHeaderCell>
                      <TableHeaderCell>说明</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dataDiff.map((diff) => (
                      <TableRow key={diff.table}>
                        <TableCell><Button size="small" onClick={()=>setDetailDiff(diff)}>{diff.table}</Button></TableCell>
                        <TableCell>{diff.sourceRows}</TableCell>
                        <TableCell>{diff.targetRows}</TableCell>
                        <TableCell>{diff.inserts}</TableCell>
                        <TableCell>{diff.updates}</TableCell>
                        <TableCell>{diff.deletes}</TableCell>
                        <TableCell className={styles.muted}>
                          {diff.note ?? (diff.skipped ? "已跳过" : "")}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {logLines.length > 0 && (
              <div className={styles.diffCard}>
                <div className={styles.diffTitle}>执行日志</div>
                <pre className={styles.log}>{logLines.join("\n")}</pre>
              </div>
            )}
          </>
        )}
      </fieldset>

      <Dialog open={active&&!!detailDiff} onOpenChange={(_,d)=>{if(!d.open)setDetailDiff(null);}}><DialogSurface style={{maxWidth:900}}><DialogBody><DialogTitle>{detailDiff?.table} · 行级差异</DialogTitle><DialogContent>
      <InfoHint label="差异预览说明">展示前 100 条差异，每条最多 100 个字段，每个值最多 256 字符；完整统计见列表。</InfoHint>
      {detailDiff?.samples.map((row,i)=><section key={i} style={{marginBottom:16}}><strong>{{insert:"新增",update:"更新",delete:"删除"}[row.kind]} · 主键 {row.key}</strong><Table size="extra-small"><TableHeader><TableRow><TableHeaderCell>字段</TableHeaderCell><TableHeaderCell>目标当前值</TableHeaderCell><TableHeaderCell>源值</TableHeaderCell></TableRow></TableHeader><TableBody>{row.fields.map(f=><TableRow key={f.column}><TableCell>{f.column}</TableCell><TableCell style={{overflowWrap:"anywhere",whiteSpace:"pre-wrap"}}>{f.before??"（不存在）"}</TableCell><TableCell style={{overflowWrap:"anywhere",whiteSpace:"pre-wrap"}}>{f.after??"（不存在）"}</TableCell></TableRow>)}</TableBody></Table></section>)}
      </DialogContent><DialogActions><Button onClick={()=>setDetailDiff(null)}>关闭</Button></DialogActions></DialogBody></DialogSurface></Dialog>
      {preview && <ConfirmSqlDialog open visible={active} title={preview.title} loadPreview={async()=>preview.lines} onApply={async()=>{}} onClose={()=>setPreview(null)} onDone={()=>{}} informativeOnly />}
      <SchemaPlanDialog open={pendingSchema} visible={active} tabId={tab?.id}
        request={{source: sourceEndpoint(), target: targetEndpoint(), tables: selectedTables, options: schemaOptions}}
        onClose={() => setPendingSchema(false)} onDone={() => void compareSchema()} onLog={appendLog} />

      <ConfirmSqlDialog
        taskKind="同步"
        visible={active}
        tabId={tab?.id}
        open={pendingData}
        sessionId={targetSession}
        title="执行数据同步"
        warning={
          dataOptions.deleteExtra
            ? "已启用「删除目标多余的行」。执行前会在本机保存含原始数据的回滚 SQL；它不覆盖触发器、级联或结构变化，请确认目标和数据库备份。"
            : "数据将按主键以源为准写入目标。执行前会在本机保存含原始数据的回滚 SQL，请确认目标库正确。"
        }
        loadPreview={async () => {
          const diff = await api.syncCompareData({
            source: sourceEndpoint(),
            target: targetEndpoint(),
            tables: selectedTables,
            options: dataOptions,

        filters:selectedFilters,},tab?.id);
          return ["源数据筛选："+(hasFilters?Object.entries(selectedFilters).filter(([,f])=>f.conditions.length).map(([table,f])=>table+" ["+f.conjunction.toUpperCase()+"]: "+f.conditions.map(c=>c.column+" "+c.operator+" "+(c.value??"")+(c.value2?" ~ "+c.value2:"")).join("；")).join("\n"):"未设置（全部源行）"),...diff.map(
            (item) =>
              `${item.table}: +${item.inserts} ~${item.updates} -${item.deletes}${
                item.note ? `（${item.note}）` : ""
              }`,
          )];
        }}
        onApply={async () => {
          const result = await api.syncExecuteData({
            source: sourceEndpoint(),
            target: targetEndpoint(),
            tables: selectedTables,
            options: dataOptions,

        filters:selectedFilters,},tab?.id);
          appendLog("回滚材料已保存到：" + result.backupDirectory + "（先阅读 README，按提交批次倒序恢复）");
          for (const table of result.tables) {
            appendLog(
              `${table.table}: 插入 ${table.inserts}，更新 ${table.updates}，删除 ${table.deletes}${
                table.error ? `，错误：${table.error}` : ""
              }`,
            );
          }
          if (result.tables.some(table => table.error || table.failed > 0)) {
            notify.error("请查看执行日志和回滚目录，部分表未完成同步。", "数据同步未全部完成");
          } else {
            notify.success("数据同步完成");
          }
        }}
        onClose={() => setPendingData(false)}
        onDone={() => void compareData()}
      />
    </div>
  );
}
