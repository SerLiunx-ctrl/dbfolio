import {useObjectPreferences} from '../../stores/useObjectPreferences';
import {AiSqlEdit,type SqlEditRequest} from "./AiSqlEdit";
import {invoke} from "@tauri-apps/api/core";
import {useSettingsStore} from "../../stores/useSettingsStore";
import {ResultCompareActions} from '../compare/ResultCompare';
import {useManualTransaction,TransactionControls} from './useManualTransaction';
import {SqlSplit} from './SqlSplit';
import {ResizableSqlArea} from './ResizableSqlArea';
import {appendGeneratedSql} from '../query/appendGeneratedSql';
import {InfoHint} from '../../common/InfoHint';
import {SmartSqlPanel} from './SmartSqlPanel';
import { openAnalysis } from "../analysis/AnalysisWorkspace";
import {newPlan,fromSql,autoChart,queryResultScope} from "../analysis/model";
import { useEditorTheme } from "../../useEditorTheme";
import { registerQueryActions } from "./queryActions";
import { currentStatement, namedParameters, fillParameters, formatSql } from "./sqlText";
import {ExplainView} from "./ExplainView";
import { rememberSqlFile } from "../../stores/useLibrary";
import { registerSqlCompletion } from "./sqlCompletion";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { useTabStore } from "../../stores/useTabStore";
import { confirmEdits, usePendingEdit } from "../../stores/useEditGuard";
import { EnvironmentBadge } from "../sessions/EnvironmentBadge";
import { useSessionStore } from "../../stores/useSessionStore";
import { updateDraft, saveDraft, useWorkspace } from "../../stores/useWorkspace";
import Editor, { type OnMount } from "@monaco-editor/react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Input,
  Field,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Option,
  Spinner,
  Tooltip,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  DataBarVerticalRegular,
  ArrowDownloadRegular,
  ArrowLeftRegular,
  ArrowRightRegular,
  CopyRegular,
  HistoryRegular,
  FolderOpenRegular,
  PlayRegular,
  TextAlignLeftRegular,
  StopRegular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNotify } from "../../app/toast";
import { api, normalizeError } from "../../ipc";
import type { DbValue, HistoryEntry, QueryOutcome, SortSpec } from "../../ipc/types";
import type { QueryTab } from "../../stores/useTabStore";
import { useExplorerStore } from "../../stores/useExplorerStore";
import { ResultGrid, type ResultGridHandle } from "../grid/ResultGrid";
import { ExportDialog } from "../transfer/ExportDialog";
import type * as Monaco from "monaco-editor";



const useStyles = makeStyles({
  root: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 10px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    flexShrink: 0,
    flexWrap: "wrap",
  },
  resultWrap: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  resultToolbar: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "4px 10px",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
  },
  grid: {
    flex: 1,
    minHeight: 0,
  },
  error: {
    margin: "8px 12px",
    padding: "8px 12px",
    borderRadius: "6px",
    backgroundColor: tokens.colorPaletteRedBackground1,
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "pre-wrap",
    userSelect: "text",
  },
  dbSelect: { minWidth: "160px" },
  spacer: { flex: 1 },
  historyItem: {
    maxWidth: "420px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    display: "block",
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    fontSize: tokens.fontSizeBase200,
  },
});

interface Props {
  tab: QueryTab;
}

export function QueryWorkspace({ tab }: Props) {
  const [pageSize,setPageSize] = useState(useSettingsStore.getState().queryPageSize);
  const targetSession = useSessionStore(state => state.sessions.find(item => item.id === tab.sessionId));
  const styles = useStyles();
  const notify = useNotify();
  const editorTheme=useEditorTheme();
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const runRef = useRef<(force: boolean, mode?: "auto" | "current" | "selection") => void>(() => {});
  const queryIdleRef=useRef<{set:(value:boolean)=>void}|null>(null);
  const fileIdleRef=useRef<{set:(value:boolean)=>void}|null>(null);
  const menuRef=useRef<{dispose:()=>void}|null>(null);
  const [aiEdit,setAiEdit]=useState<SqlEditRequest|null>(null);
  const aiEditLock=useRef(false);
  const aiEditRef=useRef<(mode:"format"|"optimize")=>void>(()=>{});
  const formatRef=useRef<()=>void>(()=>{});
  const resultGridRef = useRef<ResultGridHandle | null>(null);

  const [smartOpen,setSmartOpen]=useState<boolean|null>(null);
  const [sql, setSql] = useState(() => useWorkspace.getState().drafts[tab.id]?.sql ?? "");
  const [savedSql,setSavedSql]=useState(() => useWorkspace.getState().saved[tab.id]?.sql ?? "");
  const [filePath,setFilePath]=useState(()=>useWorkspace.getState().drafts[tab.id]?.filePath ?? "");
  const [fileBaseline,setFileBaseline]=useState(()=>useWorkspace.getState().drafts[tab.id]?.fileBaseline ?? "");
  const [draftName,setDraftName]=useState(()=>useWorkspace.getState().drafts[tab.id]?.name ?? "");
  const [fileBusy,setFileBusy]=useState(false);
  const fileLock=useRef(false);
  const saveFileRef=useRef<()=>void>(()=>{});
  const savedDrafts=useWorkspace(s=>s.saved);
  const [database, setDatabase] = useState(useWorkspace.getState().drafts[tab.id]?.database ?? tab.database);
  const documentDraft=(text=sql)=>({sql:text,database,sessionId:tab.sessionId,updatedAt:new Date().toISOString(),name:draftName,filePath,fileBaseline});
  useEffect(()=>{updateDraft(tab.id,documentDraft());},[sql,database,tab.id,tab.sessionId,draftName,filePath,fileBaseline]);
  useEffect(()=>{const title=filePath.split(/[\\/]/).pop() || draftName.trim() || "查询";
    useTabStore.setState(state=>({tabs:state.tabs.map(item=>item.id===tab.id?{...item,title}:item)}));
  },[tab.id,filePath,draftName]);
  const saveLocal=async()=>{await saveDraft(tab.id,documentDraft());setSavedSql(sql);};
  const baseline=filePath ? fileBaseline : savedSql;
  usePendingEdit({tabId:tab.id,sessionId:tab.sessionId,label:(filePath || draftName || database)+"（SQL）",busy:()=>fileLock.current,save:async()=>{if(filePath){if(!await saveFile(false))throw Error("已取消文件保存");}else await saveLocal();},discard:()=>{setSql(baseline);updateDraft(tab.id,documentDraft(baseline));}},sql!==baseline || fileBusy);
  const saveFile=async(asCopy:boolean)=>{
    if(fileLock.current) throw Error("文件操作进行中");
    fileLock.current=true;setFileBusy(true);
    try {
      const path=asCopy || !filePath ? await saveFileDialog({defaultPath:filePath || `${draftName.trim() || "查询"}.sql`,filters:[{name:"SQL 文件",extensions:["sql"]}]}) : filePath;
      if(!path)return false;
      const expected=path===filePath ? fileBaseline : await api.sqlFileRead(path);
      await api.sqlFileWrite(path,sql,expected);
      void rememberSqlFile({path,sessionId:tab.sessionId,database}).catch(e=>notify.error(e,"记录最近 SQL 文件失败"));
      setFilePath(path);setFileBaseline(sql);setSavedSql(sql);
      await saveDraft(tab.id,{...documentDraft(),filePath:path,fileBaseline:sql});
      notify.success("SQL 文件已保存");return true;
    } finally {fileLock.current=false;setFileBusy(false);}
  };
  saveFileRef.current=()=>void saveFile(false).catch(e=>notify.error(e,"保存 SQL 文件失败"));
  const openFile=async()=>{
    if(fileLock.current)return;
    if(!await confirmEdits(e=>e.tabId===tab.id))return;
    fileLock.current=true;setFileBusy(true);
    try {
      const path=await openFileDialog({multiple:false,directory:false,filters:[{name:"SQL 文件",extensions:["sql"]}]});
      if(typeof path!=="string")return;
      const text=await api.sqlFileRead(path);
      if(text===null)throw Error("文件不存在");
      await rememberSqlFile({path,sessionId:tab.sessionId,database});
      setSql(text);setFilePath(path);setFileBaseline(text);setSavedSql(text);
      await saveDraft(tab.id,{...documentDraft(text),filePath:path,fileBaseline:text});
    }catch(e){notify.error(e,"打开 SQL 文件失败");}
    finally{fileLock.current=false;setFileBusy(false);}
  };
  const [result, setResult] = useState<QueryOutcome | null>(null);
  const [lastSql, setLastSql] = useState("");
  const [resultDatabase,setResultDatabase]=useState(database);
  const [offset, setOffset] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedSql,setFailedSql]=useState("");
  const production=useObjectPreferences(s=>s.environments[tab.sessionId]==='production');
  const [dangerConfirmation,setDangerConfirmation]=useState('');
  const [danger, setDanger] = useState<{ message: string; sql:string; run: () => void } | null>(null);
  const [parameters, setParameters] = useState<{sql:string; values:Record<string,{type:string;value:string}>}|null>(null);
  const [parameterBusy,setParameterBusy]=useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [sort, setSort] = useState<SortSpec[]>([]);
  const [lastForce, setLastForce] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const [explainResult, setExplainResult] = useState<QueryOutcome | null>(null);
  const [explainLoading, setExplainLoading] = useState(false);

  const databases = useExplorerStore((s) => s.databases[tab.sessionId]);
  const loadDatabases = useExplorerStore((s) => s.loadDatabases);

  useEffect(() => {
    setDatabase(useWorkspace.getState().drafts[tab.id]?.database ?? tab.database);
  }, [tab.database]);

  useEffect(() => {
    if (!databases) {
      loadDatabases(tab.sessionId).catch(() => {});
    }
  }, [databases, loadDatabases, tab.sessionId]);

  const dbOptions = useMemo(() => {
    const names = (databases ?? []).map((d) => d.name);
    if (!names.includes(database)) names.unshift(database);
    return names;
  }, [databases, database]);

  const executionLock=useRef(false);
  const transaction=useManualTransaction(tab.id,tab.sessionId,database,()=>executionLock.current||running);
  const [resultTransaction,setResultTransaction]=useState<string|null>(null);
  const executeQuery = useCallback(
    async (text: string, force: boolean, sortSpecs: SortSpec[]) => {
      if(executionLock.current||transaction.busy||transaction.lost)return;executionLock.current=true;
      setRunning(true);
      setError(null);
      const started = performance.now();
      try {
        const limit = useSettingsStore.getState().queryPageSize;
        const outcome = transaction.transaction ? await transaction.execute(text,force,0,sortSpecs,limit) : await api.queryExecute(tab.sessionId, database, text, {
          force,
          limit,
          sort: sortSpecs,
        });
        setPageSize(limit);
        setResultTransaction(transaction.transaction?.id??null);
        setResult(outcome);
        setResultDatabase(database);
        setLastSql(text);
        setLastForce(force);
        setSort(sortSpecs);
        setOffset(0);
        setElapsed(Math.round(performance.now() - started));
      } catch (err) {
        const payload = normalizeError(err);
        if (payload.code === "E_DANGEROUS") {
          setDangerConfirmation("");
          setDanger({
            sql:text,
            message: payload.message,
            run: () => void executeQuery(text, true, sortSpecs),
          });
        } else {
          setFailedSql(text);setError(payload.message);
        }
      } finally {
        executionLock.current=false;setRunning(false);
      }
    },
    [database, tab.sessionId, transaction.transaction, transaction.busy, transaction.lost],
  );

  const run = useCallback(
    async (force: boolean, mode: "auto" | "current" | "selection" = "auto") => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      const selection = editor?.getSelection();
      let text = model ? currentStatement(model.getValue(),model.getOffsetAt(editor!.getPosition()!),targetSession?.engine) : sql;
      if (mode === "selection" && (!model || !selection || selection.isEmpty())) {
        notify.error(Error("请先选中要执行的 SQL"), "无法执行");return;
      }
      if (mode !== "current" && model && selection && !selection.isEmpty()) {
        const selected = model.getValueInRange(selection);
        if (mode === "selection" || selected.trim()) text = selected;
      }
      if (!text.trim()) {
        notify.error(new Error("请输入 SQL"), "无法执行");
        return;
      }
      if(running || parameterBusy || parameters || danger)return;
      const names=[...new Set(namedParameters(text,targetSession?.engine).map(p=>p.name))];
      if(names.length){setParameters({sql:text,values:Object.fromEntries(names.map(name=>[name,{type:"text",value:""}]))});return;}
      await executeQuery(text, force, []);
    },
    [executeQuery, notify, sql, running, parameterBusy, parameters, danger, targetSession?.engine],
  );
  runRef.current = (force, mode) => void run(force, mode);
  useEffect(()=>{queryIdleRef.current?.set(!running && !parameterBusy && !parameters && !danger);fileIdleRef.current?.set(!fileBusy);},[running,parameterBusy,parameters,danger,fileBusy]);

  const applySort = useCallback(
    (next: SortSpec[]) => {
      setSort(next);
      if (lastSql) {
        void executeQuery(lastSql, lastForce, next);
      }
    },
    [executeQuery, lastForce, lastSql],
  );

  const runExplain = async () => {
    if(transaction.transaction){notify.error(Error("请结束事务后再查看执行计划"));return;}
    const editor = editorRef.current;
    const model = editor?.getModel();
    const selection = editor?.getSelection();
      let text = model && editor?.getPosition() ? currentStatement(model.getValue(),model.getOffsetAt(editor.getPosition()!),targetSession?.engine) : sql;
    if (model && selection && !selection.isEmpty()) {
      const selected = model.getValueInRange(selection);
      if (selected.trim()) text = selected;
    }
    if (!text.trim()) {
      notify.error(new Error("请输入 SQL"), "无法生成执行计划");
      return;
    }
    setExplainLoading(true);
    try {
      setExplainResult(await api.queryExplain(tab.sessionId, database, text));
      setExplainOpen(true);
    } catch (error) {
      notify.error(error, "生成执行计划失败");
    } finally {
      setExplainLoading(false);
    }
  };

  const [elapsed, setElapsed] = useState<number | null>(null);

  const formatEditor = () => {
    const editor=editorRef.current,model=editor?.getModel();if(!editor||!model)return;
    const selection=editor.getSelection();const range=selection&&!selection.isEmpty()?selection:model.getFullModelRange();
    editor.pushUndoStop();editor.executeEdits("format-sql",[{range,text:formatSql(model.getValueInRange(range),targetSession?.engine)}]);editor.pushUndoStop();
  };
  formatRef.current=formatEditor;
  aiEditRef.current=async(mode)=>{
    if(aiEditLock.current||aiEdit)return;
    const editor=editorRef.current,model=editor?.getModel(),selection=editor?.getSelection();
    if(!editor||!model||!selection||selection.isEmpty())return;
    const selectedSql=model.getValueInRange(selection),version=model.getVersionId(),context={...completionContext.current};
    aiEditLock.current=true;
    try{
      await invoke('query_validate_sql',{sessionId:tab.sessionId,sql:selectedSql});
      if(editor.getModel()!==model||model.isDisposed()||model.getVersionId()!==version||completionContext.current.database!==context.database)throw Error('编辑内容或数据库已变化，请重新选择 SQL。');
      setAiEdit({mode,sql:selectedSql,apply:text=>{
        if(editor.getModel()!==model||model.isDisposed()||model.getVersionId()!==version||completionContext.current.database!==context.database)throw Error('编辑内容或数据库已变化，请关闭预览后重新选择 SQL。');
        editor.pushUndoStop();editor.executeEdits('ai-sql-edit',[{range:selection,text}]);editor.pushUndoStop();
      }});
    }catch(e){notify.error(e,'无法处理选中 SQL');}finally{aiEditLock.current=false;}
  };
  const submitParameters = async () => {
    if(!parameters||parameterBusy)return;setParameterBusy(true);
    try {
      const values:Record<string,DbValue>=Object.create(null);
      for(const [name,p] of Object.entries(parameters.values)){
        if(p.type==="null")values[name]=["null",null];
        else if(p.type==="number") {if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(p.value))throw Error(name+" 不是有效数字");values[name]=["decimal",p.value];}
        else if(p.type==="bool"){if(!["true","false"].includes(p.value.toLowerCase()))throw Error(name+" 请输入 true 或 false");values[name]=["bool",p.value.toLowerCase()==="true"];}
        else values[name]=["text",p.value];
      }
      const literals=await api.queryParameterLiterals(tab.sessionId,values);
      const text=fillParameters(parameters.sql,literals,targetSession?.engine);setParameters(null);await executeQuery(text,false,[]);
    }catch(e){notify.error(e,"参数执行失败");}finally{setParameterBusy(false);}
  };
  const completionRef=useRef<{dispose:()=>void}|null>(null);
  const completionContext=useRef({sessionId:tab.sessionId,database});completionContext.current={sessionId:tab.sessionId,database};
  useEffect(()=>()=>{completionRef.current?.dispose();menuRef.current?.dispose();},[]);
  const onMount: OnMount = (editor, monacoInstance) => {
    editorRef.current = editor;
    queryIdleRef.current=editor.createContextKey("dwQueryIdle",!running && !parameterBusy && !parameters && !danger);
    fileIdleRef.current=editor.createContextKey("dwQueryFileIdle",!fileBusy);
    menuRef.current?.dispose();
    menuRef.current=registerQueryActions(editor,{runCurrent:()=>runRef.current(false,"current"),runSelection:()=>runRef.current(false,"selection"),format:()=>formatRef.current(),aiFormat:()=>aiEditRef.current("format"),aiOptimize:()=>aiEditRef.current("optimize"),save:()=>saveFileRef.current(),history:()=>window.dispatchEvent(new Event("dw:history"))});
    editor.addAction({id:"dw-format-sql",label:"格式化 SQL",keybindings:[monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyMod.Shift | monacoInstance.KeyCode.KeyF],run:()=>formatRef.current()});
    completionRef.current?.dispose();
    completionRef.current=registerSqlCompletion(editor,monacoInstance,()=>completionContext.current);
    editor.addCommand(
      monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Enter,
      () => runRef.current(false),
    );
    editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS,()=>saveFileRef.current());
  };

  const cancel = async () => {
    try {
      await api.queryCancel(tab.sessionId);
    } catch (err) {
      notify.error(err, "取消失败");
    }
  };

  const fetchPage = async (nextOffset: number) => {
    if (!lastSql || transaction.busy || transaction.lost || (resultTransaction!==null && resultTransaction!==transaction.transaction?.id)) return;
    setRunning(true);
    try {
      const outcome = transaction.transaction ? await transaction.execute(lastSql,true,nextOffset,sort,pageSize) : await api.queryFetchPage(
        tab.sessionId,
        resultDatabase,
        lastSql,
        nextOffset,
        pageSize,
        sort,
      );
      setResult(outcome);
      setOffset(nextOffset);
    } catch (err) {
      notify.error(err, "加载失败");
    } finally {
      setRunning(false);
    }
  };

  const loadHistory = async () => {
    try {
      setHistory(await api.queryHistory(tab.sessionId, 30));
    } catch (err) {
      notify.error(err, "加载历史失败");
    }
  };

  const rowCount = result ? result.rows.length : 0;
  const hasPrev = offset > 0;
  const hasNext = result !== null && rowCount === pageSize;

  return (
    <div className={styles.root}>
      <Dialog open={!!parameters} onOpenChange={(_,d)=>{if(!d.open&&!parameterBusy)setParameters(null);}}><DialogSurface><DialogBody><DialogTitle>命名参数</DialogTitle><DialogContent>
        <InfoHint label="查询参数说明">使用 :参数名。文本会按数据库规则转义；数字、布尔值与 NULL 单独输入。参数替换后的 SQL 会进入执行历史。</InfoHint>
        {Object.entries(parameters?.values??{}).map(([name,p])=><Field key={name} label={name}><div style={{display:"flex",gap:8,marginBottom:8}}><select className="dw-native-select" disabled={parameterBusy} value={p.type} onChange={e=>setParameters(old=>old?{...old,values:{...old.values,[name]:{...p,type:e.target.value}}}:old)}><option value="text">文本</option><option value="number">数字</option><option value="bool">布尔</option><option value="null">NULL</option></select><Input disabled={parameterBusy||p.type==="null"} value={p.value} onChange={(_,d)=>setParameters(old=>old?{...old,values:{...old.values,[name]:{...p,value:d.value}}}:old)}/></div></Field>)}
      </DialogContent><DialogActions><Button disabled={parameterBusy} onClick={()=>setParameters(null)}>取消</Button><Button appearance="primary" disabled={parameterBusy} onClick={()=>void submitParameters()}>执行</Button></DialogActions></DialogBody></DialogSurface></Dialog>
      <div className={styles.toolbar}>
        <Tooltip content="执行 (Ctrl+Enter)" relationship="label">
          <Button
            appearance="primary"
            size="small"
            icon={running ? <Spinner size="tiny" /> : <PlayRegular />}
            disabled={running||transaction.busy||transaction.lost}
            onClick={() => void run(false)}
          >
            执行当前语句
          </Button>
        </Tooltip>
        <Button size="small" icon={<TextAlignLeftRegular />} onClick={formatEditor}>格式化</Button>
        <Button size="small" appearance={smartOpen?"primary":"secondary"} aria-pressed={!!smartOpen} onClick={()=>setSmartOpen(v=>!v)}>智能生成</Button>
        <Button
          size="small"
          icon={<StopRegular />}
          disabled={!running}
          onClick={() => void cancel()}
        >
          取消
        </Button>
        <TransactionControls state={transaction} disabled={running} readOnly={!!targetSession?.readOnly}/>
        <Dropdown
          disabled={running||transaction.busy||!!transaction.transaction}
          className={styles.dbSelect}
          size="small"
          selectedOptions={[database]}
          value={database}
          onOptionSelect={(_, data) => {
            if (data.optionValue) setDatabase(data.optionValue);
          }}
        >
          {dbOptions.map((name) => (
            <Option key={name} value={name}>
              {name}
            </Option>
          ))}
        </Dropdown>
        <Menu><MenuTrigger disableButtonEnhancement><Button size="small" icon={<FolderOpenRegular/>}>文件</Button></MenuTrigger><MenuPopover><MenuList>
          <MenuItem disabled={fileBusy} onClick={()=>void openFile()}>打开 SQL</MenuItem>
          <MenuItem disabled={fileBusy} onClick={()=>saveFileRef.current()}>保存文件</MenuItem>
          <MenuItem disabled={fileBusy} onClick={()=>void saveFile(true).catch(e=>notify.error(e,"另存为失败"))}>另存为</MenuItem>
          <MenuItem disabled={fileBusy} onClick={()=>void saveLocal().catch(e=>notify.error(e))}>保存草稿</MenuItem>
        </MenuList></MenuPopover></Menu>
        <Menu><MenuTrigger disableButtonEnhancement><Button size="small">草稿库</Button></MenuTrigger><MenuPopover><MenuList>
        {Object.entries(savedDrafts).filter(([,d])=>d.sessionId===tab.sessionId).map(([id,d])=><MenuItem disabled={fileBusy} icon={<HistoryRegular />} key={id} onClick={async()=>{if(await confirmEdits(e=>e.tabId===tab.id)){setFilePath("");setFileBaseline("");setDraftName(d.name??"");setSql(d.sql);setSavedSql(d.sql);setDatabase(d.database);}}}>{d.name || d.database} · {d.sql.slice(0,50) || "空草稿"}</MenuItem>)}
        </MenuList></MenuPopover></Menu>
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button
              size="small"
              icon={<HistoryRegular />}
              onClick={() => void loadHistory()}
            >
              历史
            </Button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem icon={<HistoryRegular />} onClick={()=>window.dispatchEvent(new Event("dw:history"))}>打开历史中心</MenuItem>
              {history.length === 0 && <MenuItem icon={<HistoryRegular />} disabled>暂无历史</MenuItem>}
              {history.map((entry) => (
                <MenuItem icon={<HistoryRegular />} key={entry.id} onClick={async () => { if(await confirmEdits(e=>e.tabId===tab.id)) setSql(entry.sql); }}>
                  <span className={styles.historyItem}>{entry.sql.replace(/\s+/g, " ")}</span>
                </MenuItem>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
        <Button
          size="small"
          icon={explainLoading ? <Spinner size="tiny" /> : undefined}
          disabled={explainLoading||!!transaction.transaction}
          onClick={() => void runExplain()}
        >
          执行计划
        </Button>
        <div className={styles.spacer} />
        {running && <Spinner size="tiny" label="执行中…" />}
      </div>

      <ResizableSqlArea expanded={!!smartOpen} storageKey="dw.query.editorHeight" reserveResults><SqlSplit open={!!smartOpen} storageKey="dw.query.sqlSplit"><div className="dw-smart-sql dw-query-sql-pane">
      <header className="dw-sql-pane-header"><strong>SQL</strong>
        <Input size="small" aria-label="草稿名称" placeholder="给草稿命名" value={draftName} disabled={fileBusy} onChange={(_,d)=>setDraftName(d.value)} />
        <span title={filePath} style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:12}}>{filePath || "本地草稿"}{sql!==baseline ? " · 未保存" : " · 已保存"}</span>
      </header>
<div className="dw-sql-editor-body">
        <Editor
          language="sql"
          theme={editorTheme.name} beforeMount={editorTheme.beforeMount}
          value={sql}
          onChange={(value) => setSql(value ?? "")}
          onMount={onMount}
          options={{
            readOnly:fileBusy,
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            automaticLayout: true,
            wordWrap: "on",
            tabSize: 2,
          }}
        />
      </div></div><div hidden={!smartOpen} className="dw-smart-side">{smartOpen!==null&&<SmartSqlPanel visible={!!smartOpen} key={tab.sessionId+database} sessionId={tab.sessionId} database={database} tabId={tab.id} sql={sql} executionError={error&&failedSql===sql?error:""} disabled={fileBusy} onClose={()=>setSmartOpen(false)} onAppend={text=>setSql(v=>appendGeneratedSql(v,text))} />}</div></SqlSplit></ResizableSqlArea>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.resultWrap}>
        <div className={styles.resultToolbar}>
          {result && result.columns.length > 0 && (
            <>
              <span>
                第 {offset + 1} - {offset + rowCount} 行
              </span>
              {elapsed !== null && <span title="从页面发起请求到收到结果，包含通信、后端处理和历史记录保存，不含最终页面绘制">请求总耗时 {elapsed} ms</span>}
            </>
          )}
          {result && result.columns.length === 0 && result.affected !== null && (
            <span>受影响行数 {result.affected}</span>
          )}
          <div className={styles.spacer} />
          <ResultCompareActions result={result} source={(targetSession?.name??tab.sessionId)+" / "+resultDatabase} scope={`已加载第 ${offset+1}–${offset+rowCount} 行${resultTransaction?" · 事务内快照（不代表已提交）":""}`} disabled={running}/>
          <Button size="small" appearance="subtle" icon={<DataBarVerticalRegular/>} disabled={running||!!resultTransaction||!result?.columns.length} onClick={()=>{if(!result)return;const data=fromSql(result,queryResultScope(result.rows.length,offset,pageSize));const plan=newPlan(tab.sessionId,resultDatabase);plan.query=lastSql;plan.name="查询分析";plan.chart=autoChart(data);openAnalysis(plan,data);}} title="复制当前查询页作为绘图快照；在独立分析页可以另写查询，不影响本页">用此结果绘图</Button>
          <Button
            appearance="subtle"
            size="small"
            icon={<CopyRegular />}
            disabled={!result || result.rows.length === 0}
            onClick={() => {
              void resultGridRef.current?.copySelected();
            }}
          >
            复制
          </Button>
          <Button
            appearance="subtle"
            size="small"
            icon={<ArrowDownloadRegular />}
            disabled={!!resultTransaction || !!transaction.transaction || !lastSql || !result || result.columns.length === 0}
            onClick={() => setExportOpen(true)}
          >
            导出
          </Button>
          <Button
            appearance="subtle"
            size="small"
            icon={<ArrowLeftRegular />}
            disabled={!hasPrev || running || transaction.lost || (!!resultTransaction && resultTransaction!==transaction.transaction?.id)}
            onClick={() => void fetchPage(Math.max(0, offset - pageSize))}
          >
            上一页
          </Button>
          <Button
            appearance="subtle"
            size="small"
            icon={<ArrowRightRegular />}
            disabled={!hasNext || running || transaction.lost || (!!resultTransaction && resultTransaction!==transaction.transaction?.id)}
            onClick={() => void fetchPage(offset + pageSize)}
          >
            下一页
          </Button>
        </div>
        <div className={styles.grid}>
          {result && result.columns.length > 0 ? (
            <ResultGrid
              ref={resultGridRef}
              columns={result.columns}
              rows={result.rows}
              onSortChange={transaction.lost || (!!resultTransaction && resultTransaction!==transaction.transaction?.id) ? undefined : applySort}
            />
          ) : (
            !running &&
            !error && (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: tokens.colorNeutralForeground3,
                  fontSize: 13,
                }}
              >
                {result ? "语句执行完成" : "按 Ctrl+Enter 执行 SQL，选中文本时可只执行选中部分"}
              </div>
            )
          )}
        </div>
      </div>

      <Dialog
        open={danger !== null}
        onOpenChange={(_, data) => {
          if (!data.open) setDanger(null);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>危险操作确认</DialogTitle>
            <DialogContent>
              <p>目标：{targetSession?.name} / {database}<EnvironmentBadge sessionId={tab.sessionId}/></p>
              <div style={{ color: tokens.colorPaletteRedForeground1 }}>{danger?.message}</div>
              <pre style={{maxHeight:220,overflow:'auto',fontSize:12,whiteSpace:'pre-wrap'}}>{danger?.sql}</pre>
              {production?<Input size="small" aria-label="生产危险操作确认" placeholder={'输入数据库名 '+database+' 确认执行'} value={dangerConfirmation} onChange={(_,d)=>setDangerConfirmation(d.value)}/>:<div style={{ marginTop: 8 }}>请核对以上 SQL 的影响范围后继续。</div>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDanger(null)}>
                取消
              </Button>
              <Button
                appearance="primary"
                disabled={production&&dangerConfirmation!==database}
                onClick={() => {
                  if(production&&dangerConfirmation!==database)return;
                  const current = danger;
                  setDanger(null);
                  current?.run();
                }}
              >
                确认执行
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <ExportDialog
        open={exportOpen}
        sessionId={tab.sessionId}
        database={database}
        sql={lastSql}
        sort={sort}
        pageSize={pageSize}
        pageOffset={offset}
        defaultName={`query_${new Date().toISOString().slice(0, 10)}`}
        onClose={() => setExportOpen(false)}
      />

      {aiEdit&&<AiSqlEdit request={aiEdit} sessionId={tab.sessionId} database={database} tabId={tab.id} onClose={()=>setAiEdit(null)}/>}
      <Dialog
        open={explainOpen}
        onOpenChange={(_, data) => {
          if (!data.open) setExplainOpen(false);
        }}
      >
        <DialogSurface style={{ maxWidth: "960px" }}>
          <DialogBody>
            <DialogTitle>执行计划</DialogTitle>
            <DialogContent>
              <div style={{ maxHeight: "65vh", overflow: "auto", width: "100%" }}>
                {explainResult && (
                  <ExplainView result={explainResult}/>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setExplainOpen(false)}>
                关闭
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
