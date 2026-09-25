import {SqlSplit} from '../query/SqlSplit';
import {ResizableSqlArea} from '../query/ResizableSqlArea';
import {appendGeneratedSql} from '../query/appendGeneratedSql';
import {SmartSqlPanel} from '../query/SmartSqlPanel';
import {InfoHint} from '../../common/InfoHint';
import {AnalysisSqlEditor} from './AnalysisSqlEditor';
import {AnalysisRelations} from './AnalysisRelations';
import {applyLookup,lookupColumnId,lookupSql,withComments} from './lookup';
import {mongoParams,bindMongo,parameter} from "./parameters";
import {lazy,Suspense,useEffect,useMemo,useRef,useState} from 'react';
import {Button,Dialog,DialogSurface,DialogBody,DialogTitle,DialogContent,DialogActions,Field,Input,Select,Spinner} from '@fluentui/react-components';
import {DataBarVerticalRegular,SaveRegular,ArrowDownloadRegular,PlayRegular,StopRegular,FolderOpenRegular,DeleteRegular,AddRegular} from '@fluentui/react-icons';
import {save} from '@tauri-apps/plugin-dialog';
import {api,normalizeError} from '../../ipc';
import {trackedInvoke} from '../../ipc/taskInvoke';
import type {DbValue,QueryOutcome} from '../../ipc/types';
import {useSessionStore} from '../../stores/useSessionStore';
import {type AnalysisTab,useTabStore} from '../../stores/useTabStore';
import {usePendingEdit} from '../../stores/useEditGuard';
import {cancelTask,isTaskActive,useTaskStore} from '../../stores/useTaskStore';
import {useNotify} from '../../app/toast';
import {namedParameters,fillParameters} from '../query/sqlText';
import {aggregate,autoChart,chartNames,csv,fromMongo,fromSql,newPlan,profile,validatePlan,type AnalysisPlan,type ChartConfig,type Dataset,type Scalar} from './model';
import {loadAnalyses,saveAnalysis,deleteAnalysis,useAnalysisLibrary,resultSnapshots} from './store';
import type {ChartHandle} from './AnalysisChart';
import './analysis.css';
const Chart=lazy(()=>import('./AnalysisChart').then(m=>({default:m.AnalysisChart})));

export function openAnalysis(plan:AnalysisPlan,data?:Dataset){const id=useTabStore.getState().openAnalysis(plan);if(data)resultSnapshots.set(id,data);useSessionStore.getState().setActiveSession(plan.sessionId);window.dispatchEvent(new Event('dw:show-workspace'));return id;}
const sourceStamp=(p:AnalysisPlan)=>JSON.stringify([p.source,p.database,p.collection,p.query,p.parameters,p.metadataSource,p.lookup]);


export function AnalysisWorkspace({tab}:{tab:AnalysisTab}) {
 const [smartOpen,setSmartOpen]=useState<boolean|null>(null);
 const [plan,setPlan]=useState(tab.plan),[data,setData]=useState<Dataset|null>(()=>resultSnapshots.get(tab.id)??null),[captured,setCaptured]=useState<AnalysisPlan|null>(()=>resultSnapshots.has(tab.id)?tab.plan:null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[note,setNote]=useState(''),[view,setView]=useState<'chart'|'data'|'profile'>('chart'),[page,setPage]=useState(0),[savedStamp,setSavedStamp]=useState('');
 const lock=useRef(false),chart=useRef<ChartHandle>(null),notify=useNotify(),session=useSessionStore(s=>s.sessions.find(v=>v.id===tab.sessionId)),connected=useSessionStore(s=>!!s.statuses[tab.sessionId]?.connected);
 const tasks=useTaskStore(s=>s.tasks),activeTasks=tasks.filter(t=>t.tabId===tab.id&&isTaskActive(t));
 useEffect(()=>{resultSnapshots.delete(tab.id);void loadAnalyses().then(()=>{const existing=useAnalysisLibrary.getState().items.find(p=>p.id===tab.plan.id);if(existing)setSavedStamp(JSON.stringify(existing));}).catch(e=>setError(normalizeError(e).message));},[]);
 useEffect(()=>useTabStore.getState().updateAnalysis(tab.id,plan),[plan,tab.id]);
 const run=async(action:()=>Promise<void>)=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');setNote('');try{await action();}catch(e){setError(normalizeError(e).message);notify.error(e,'分析操作失败');}finally{lock.current=false;setBusy(false);}};
 const persist=async()=>{const clean=validatePlan(plan);await saveAnalysis(clean);setPlan(clean);setSavedStamp(JSON.stringify(clean));setNote('分析方案已保存。下次打开后手动刷新数据。');};
 usePendingEdit({tabId:tab.id,sessionId:tab.sessionId,label:plan.name+'（分析方案）',busy:()=>lock.current,save:persist,discard:()=>{}},busy||savedStamp!==JSON.stringify(plan));
 const change=(patch:Partial<AnalysisPlan>)=>setPlan(p=>({...p,...patch}));
 const chartChange=(patch:Partial<ChartConfig>)=>change({chart:{...plan.chart,...patch}});
 const paramNames=useMemo(()=>plan.source==='sql'?[...new Set(namedParameters(plan.query,session?.engine).map(p=>p.name))]:mongoParams(plan.query),[plan.query,plan.source,session?.engine]);
 const refresh=()=>run(async()=>{
  const request=structuredClone(plan);request.parameters=Object.fromEntries(paramNames.map(name=>[name,parameter(request.parameters,name)]));
  let dataset:Dataset;
  if(request.source==='sql'){
   const values:Record<string,DbValue>=Object.fromEntries(Object.entries(request.parameters).map(([name,p])=>[name,p.type==='null'?['null',null]:p.type==='number'?['decimal',p.value]:['text',p.value]]));
   const literals=await api.queryParameterLiterals(tab.sessionId,values);
   const sql=fillParameters(request.query,literals,session?.engine);
   const response=await trackedInvoke<{result:QueryOutcome;limited:boolean;limit:number}>('analysis_query',{sessionId:tab.sessionId,database:request.database,sql});
   dataset=fromSql(response.result,response.limited?'受限结果 · 前 5,000 行（非全量、非随机抽样）':`查询结果 · ${response.result.rows.length} 行`);
  } else {
   if(!request.collection.trim())throw Error('请填写集合名称');
   const response=await trackedInvoke<{rows:unknown[];limited:boolean}>('mongo_inspect',{sessionId:tab.sessionId,database:request.database,collection:request.collection,operation:'aggregate',text:bindMongo(request.query,request.parameters)});
   dataset=fromMongo(response.rows,response.limited?'MongoDB 受限聚合结果 · 最多 500 条 / 8 MiB':`MongoDB 聚合结果 · ${response.rows.length} 条（未触及上限）`);
  }
  if(request.source==='sql'){
   if(request.metadataSource?.table){try{const meta=await api.tableDetail(tab.sessionId,request.database,request.metadataSource.table,request.metadataSource.schema||null);dataset=withComments(dataset,meta.columns);}catch(e){dataset.warnings.push('字段备注读取失败：'+normalizeError(e).message);}}
   if(request.lookup){
    const sql=lookupSql(session?.engine??'sqlite',request.database,request.lookup);
    const response=await trackedInvoke<{result:QueryOutcome;limited:boolean}>('analysis_query',{sessionId:tab.sessionId,database:request.database,sql});
    if(response.limited)throw Error('名称关联表超过 5,000 行，请在分析 SQL 中使用 JOIN 限定关联范围；原结果已保留');
    dataset=applyLookup(dataset,request.lookup,fromSql(response.result,'名称表'));
   }
  }
  setData(dataset);setCaptured(request);setPage(0);
  let nextChart=request.chart;
  if(!request.lookup&&captured?.lookup&&nextChart.x===lookupColumnId(captured.lookup.field))nextChart={...nextChart,x:captured.lookup.field};
  if(!dataset.columns.some(c=>c.id===nextChart.x)||!dataset.columns.some(c=>c.id===nextChart.y)&&nextChart.aggregate!=='count')nextChart={...autoChart(dataset),kind:nextChart.kind};
  if(request.lookup&&!['scatter','histogram','kpi'].includes(nextChart.kind)&&(nextChart.x===request.lookup.field||request.chart.x===lookupColumnId(request.lookup.field)))nextChart={...nextChart,x:lookupColumnId(request.lookup.field)};
  if(request.lookup&&nextChart.series===request.lookup.field)nextChart={...nextChart,series:lookupColumnId(request.lookup.field)};
  change({chart:nextChart});
  setNote('数据已刷新；统计范围以图表上方说明为准。');
 });
 const plotted=useMemo(()=>data?aggregate(data,plan.chart):{points:[],scatter:[],warnings:[]},[data,plan.chart]);
 const stats=useMemo(()=>data?profile(data):[],[data]);
 const normalizedSource=(p:AnalysisPlan)=>sourceStamp({...p,parameters:Object.fromEntries(paramNames.map(n=>[n,parameter(p.parameters,n)]))});
 const stale=data&&captured&&normalizedSource(plan)!==normalizedSource(captured);
 const exportFile=(kind:'png'|'csv'|'json')=>run(async()=>{
  if(!data)return;
  const path=await save({defaultPath:`${plan.name.replace(/[<>:"/\\|?*]/g,'_')}.${kind}`,filters:[{name:kind==='csv'?'当前图表数据（CSV）':kind==='json'?'分析数据与范围（JSON）':'图表图片（PNG）',extensions:[kind]}]});if(!path)return;
  let bytes:Uint8Array;
  if(kind==='png'){const url=await chart.current?.png();if(!url)throw Error('请先切换到图表页');bytes=Uint8Array.from(atob(url.split(',')[1]),c=>c.charCodeAt(0));}
  else if(kind==='json')bytes=new TextEncoder().encode(JSON.stringify({version:1,scope:data.scope,capturedAt:data.capturedAt,source:captured,chart:plan.chart,warnings:[...data.warnings,...plotted.warnings],columns:data.columns,rows:data.rows},null,2));
  else {const rows:Scalar[][]=plan.chart.kind==='scatter'?plotted.scatter:plotted.points.map(p=>[p.category,p.series,p.value]);bytes=new TextEncoder().encode(csv([...(plan.chart.kind==='scatter'?['X','Y']:['分类','系列','值']),'数据范围','采集时间'],rows.map(r=>[...r,[data.scope,...plotted.warnings].join("；"),data.capturedAt])));}
  await trackedInvoke('analysis_export',{path,bytes:Array.from(bytes)});setNote('已导出：'+path+(kind==='csv'?'（当前图表数据）':''));
 });
 const numericCols=data?.columns.filter(c=>c.numeric)??[];
 const fieldOptions=(columns=data?.columns??[])=>columns.map(c=><option key={c.id} value={c.id}>{c.name}{c.comment?' · '+c.comment:''} · {(data?.columns.findIndex(v=>v.id===c.id)??0)+1}</option>);
 const canPlot=!!data?.rows.length&&(plan.chart.kind==='scatter'?plotted.scatter.length>0:plotted.points.some(p=>p.value!==null));
 const pieInvalid=['pie','donut'].includes(plan.chart.kind)&&plotted.points.some(p=>(p.value??0)<0);
 return <section className="dw-analysis">
  <header className="dw-analysis-toolbar"><DataBarVerticalRegular/><h2>数据分析</h2><span>{session?.name} · {plan.source==='mongo'?'MongoDB':'SQL'}</span><span className="dw-analysis-spacer"/><Button size="small" icon={<FolderOpenRegular/>} onClick={()=>window.dispatchEvent(new Event('dw:analysis'))}>分析库</Button><Button size="small" icon={<SaveRegular/>} disabled={busy} onClick={()=>void run(persist)}>保存方案</Button><Button size="small" disabled={busy} onClick={()=>{change({id:crypto.randomUUID(),name:plan.name.slice(0,115)+' 副本'});setSavedStamp('');setNote('已创建副本草稿，请保存。');}}>另存为副本</Button></header>
  <details className="dw-analysis-source" open={!data}><summary>数据源与参数 · {plan.database}{plan.source==='mongo'?'.'+plan.collection:''}</summary>
   <div className="dw-analysis-fields"><Field size="small" label="方案名称"><Input size="small" disabled={busy} value={plan.name} maxLength={120} onChange={(_,v)=>change({name:v.value})}/></Field><Field size="small" label="数据库"><Input size="small" disabled={busy} value={plan.database} onChange={(_,v)=>change({database:v.value})}/></Field>{plan.source==='mongo'&&<Field size="small" label="集合"><Input size="small" disabled={busy} value={plan.collection} onChange={(_,v)=>change({collection:v.value})}/></Field>}</div>
   <Field size="small" label={plan.source==='sql'?'分析 SQL':'聚合管道（Extended JSON 数组）'}>{plan.source==='sql'?<><Button size="small" style={{width:"fit-content"}} onClick={()=>setSmartOpen(v=>!v)}>智能生成</Button><ResizableSqlArea expanded={!!smartOpen} storageKey="dw.analysis.editorHeight"><SqlSplit open={!!smartOpen} storageKey="dw.analysis.sqlSplit"><div className="dw-smart-sql"><AnalysisSqlEditor sessionId={tab.sessionId} database={plan.database} value={plan.query} readOnly={busy} onChange={query=>change({query})}/></div><div hidden={!smartOpen} className="dw-smart-side">{smartOpen!==null&&<SmartSqlPanel visible={!!smartOpen} key={tab.sessionId+plan.database} sessionId={tab.sessionId} database={plan.database} tabId={tab.id} sql={plan.query} disabled={busy} onClose={()=>setSmartOpen(false)} onAppend={text=>setPlan(p=>({...p,query:appendGeneratedSql(p.query,text)}))}/>}</div></SqlSplit></ResizableSqlArea></>:<textarea aria-label="分析查询" spellCheck={false} disabled={busy} value={plan.query} onChange={e=>change({query:e.target.value})}/>}</Field>
   <InfoHint label="分析查询与参数说明">{plan.source==='sql'?'参数写作 :start_date、:end_date 等，作为值绑定，不替换字段或表名。SQL 最多读取 5,000 行 / 8 MiB，60 秒超时。':'参数使用完整字符串占位符，例如 {"$match":{"status":":status"}}。最多读取 500 条 / 8 MiB，不支持写入阶段。'} 不自动刷新。{data?.scope.startsWith("当前查询页")?" 重新执行会按此处的分析 SQL 读取，不继承来源页码和表头排序。":""}</InfoHint>
   {paramNames.length>0&&<div className="dw-analysis-fields">{paramNames.map(name=>{const p=parameter(plan.parameters,name);const patch=(v:Partial<typeof p>)=>change({parameters:{...plan.parameters,[name]:{...p,...v}}});return <Field size="small" key={name} label={':'+name}><div className="dw-analysis-inline"><Select size="small" aria-label={name+' 参数类型'} disabled={busy} value={p.type} onChange={(_,d)=>patch({type:d.value as typeof p.type})}><option value="text">文本</option><option value="number">数值</option><option value="date">日期</option><option value="null">NULL</option></Select><Input size="small" aria-label={name+' 参数值'} disabled={busy||p.type==='null'} value={p.value} onChange={(_,d)=>patch({value:d.value})}/></div></Field>;})}</div>}
  </details>
  <div className="dw-analysis-toolbar"><Button size="small" appearance="primary" icon={<PlayRegular/>} disabled={busy||!connected} onClick={()=>void refresh()}>执行 / 刷新分析</Button>{busy&&<Spinner size="tiny" label="处理中"/>}{activeTasks.length>0&&<Button size="small" icon={<StopRegular/>} onClick={()=>void Promise.all(activeTasks.map(t=>cancelTask(t.id))).catch(e=>setError(normalizeError(e).message))}>停止查询</Button>}<span className="dw-analysis-muted">{data?`${data.scope} · 采集于 ${new Date(data.capturedAt).toLocaleString()}`:''}</span></div>
  {error&&<div role="alert" className="dw-analysis-error">{error}</div>}{note&&<div role="status" className="dw-analysis-note">{note}</div>}{stale&&<div className="dw-analysis-warning">查询、参数或关联配置已修改；当前显示上一次结果，请执行刷新。</div>}
  {plan.source==='sql'&&<AnalysisRelations plan={plan} columns={data?.columns??[]} busy={busy} connected={connected} onChange={change} onRefresh={()=>void refresh()}/>}
  {data&&<>
   <div className="dw-analysis-controls"><Field size="small" label="图表类型"><Select size="small" value={plan.chart.kind} onChange={(_,d)=>chartChange({kind:d.value as ChartConfig['kind'],series:''})}>{Object.entries(chartNames).map(([k,v])=><option key={k} value={k}>{v}</option>)}</Select></Field>
    {!['kpi','histogram'].includes(plan.chart.kind)&&<Field size="small" label={plan.chart.kind==='scatter'?'X 数值字段':'分类 / X 轴'}><Select size="small" value={plan.chart.x} onChange={(_,d)=>chartChange({x:d.value})}><option value="">选择字段</option>{fieldOptions(plan.chart.kind==='scatter'?numericCols:undefined)}</Select></Field>}
    <Field size="small" label="数值 / Y 轴"><Select size="small" disabled={plan.chart.aggregate==='count'&&!['scatter','histogram'].includes(plan.chart.kind)} value={plan.chart.y} onChange={(_,d)=>chartChange({y:d.value})}><option value="">选择字段</option>{fieldOptions(numericCols)}</Select></Field>
    {!['scatter','histogram'].includes(plan.chart.kind)&&<Field size="small" label="聚合方式"><Select size="small" value={plan.chart.aggregate} onChange={(_,d)=>chartChange({aggregate:d.value as ChartConfig['aggregate']})}><option value="sum">求和</option><option value="avg">平均值</option><option value="count">记录数（含空值行）</option><option value="min">最小值</option><option value="max">最大值</option></Select></Field>}
    {['bar','horizontal','line','area'].includes(plan.chart.kind)&&<Field size="small" label="分组系列"><Select size="small" value={plan.chart.series} onChange={(_,d)=>chartChange({series:d.value})}><option value="">不分组</option>{fieldOptions()}</Select></Field>}
    {!['scatter','histogram','kpi'].includes(plan.chart.kind)&&<><Field size="small" label="排序"><Select size="small" value={plan.chart.sort} onChange={(_,d)=>chartChange({sort:d.value as ChartConfig['sort']})}><option value="source">结果顺序</option><option value="desc">数值合计降序</option><option value="asc">数值合计升序</option></Select></Field><Field size="small" label="最多分类（1–200）"><Input size="small" type="number" value={String(plan.chart.top)} onChange={(_,d)=>chartChange({top:Math.min(200,Math.max(1,Math.trunc(Number(d.value)||1)))})}/></Field></>}
    {plan.chart.kind==='histogram'&&<Field size="small" label="分箱数（2–100）"><Input size="small" type="number" value={String(plan.chart.bins)} onChange={(_,d)=>chartChange({bins:Math.min(100,Math.max(2,Math.trunc(Number(d.value)||2)))})}/></Field>}
   </div>
   <nav className="dw-analysis-toolbar">{(['chart','data','profile'] as const).map(k=><Button size="small" key={k} appearance={view===k?'primary':'subtle'} onClick={()=>setView(k)}>{k==='chart'?'图表':k==='data'?`数据 · ${data.rows.length}`:'字段概况'}</Button>)}<span className="dw-analysis-spacer"/><Button size="small" icon={<ArrowDownloadRegular/>} disabled={busy||view!=='chart'||!canPlot||pieInvalid} onClick={()=>void exportFile('png')}>图片</Button><Button size="small" disabled={busy||!canPlot} onClick={()=>void exportFile('csv')}>图表 CSV</Button><Button size="small" disabled={busy} onClick={()=>void exportFile('json')}>数据 JSON</Button></nav>
   <div className="dw-analysis-muted">{[...data.warnings,...plotted.warnings].map(w=><p key={w}>{w}</p>)}</div>
   {view==='chart'?(pieInvalid?<p role="alert">饼图不适合负数，请选择柱状图或调整数据。</p>:canPlot?<Suspense fallback={<Spinner label="加载图表"/>}><Chart ref={chart} config={plan.chart} data={plotted} title={plan.name} scope={[...plotted.warnings,...(data.scope.startsWith("受限结果")?[data.scope]:[])].join(" · ")}/></Suspense>:<div className="dw-analysis-empty">{data.rows.length?'请选择有效分类及数值字段，或改用“记录数”。':'查询未返回数据，请调整查询或参数。'}</div>):view==='profile'?<div className="dw-analysis-table"><table><thead><tr>{['字段','类型','总行数','空 / 缺失','非空不同值','有效数值','最小','最大','平均'].map(v=><th key={v}>{v}</th>)}</tr></thead><tbody>{stats.map((p,i)=><tr key={i}>{[p.name,p.type,p.rows,p.missing,p.distinct,p.numeric,p.min,p.max,p.avg].map((v,j)=><td key={j}>{v===null?'—':String(v)}</td>)}</tr>)}</tbody></table></div>:<><div className="dw-analysis-table"><table><thead><tr>{data.columns.map(c=><th key={c.id}>{c.name}</th>)}</tr></thead><tbody>{data.rows.slice(page*100,(page+1)*100).map((r,i)=><tr key={i}>{r.map((v,j)=><td key={j} title={String(v??'NULL')}>{v===null?<em>NULL</em>:String(v)}</td>)}</tr>)}</tbody></table></div><div className="dw-analysis-toolbar"><Button size="small" disabled={!page} onClick={()=>setPage(p=>p-1)}>上一页</Button><span>{page*100+1}–{Math.min((page+1)*100,data.rows.length)} / {data.rows.length}</span><Button size="small" disabled={(page+1)*100>=data.rows.length} onClick={()=>setPage(p=>p+1)}>下一页</Button></div></>}
  </>}
 </section>;
}

export function AnalysisLauncher(){
 const [opened,setOpened]=useState(false),[sessionId,setSessionId]=useState(''),[database,setDatabase]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[deleting,setDeleting]=useState<string|null>(null);
 const sessions=useSessionStore(s=>s.sessions),plans=useAnalysisLibrary(s=>s.items),lock=useRef(false);
 useEffect(()=>{const show=()=>{const s=useSessionStore.getState();const tab=useTabStore.getState().tabs.find(t=>t.id===useTabStore.getState().activeId);const selected=s.sessions.find(v=>v.id===s.activeSessionId);setSessionId(selected?.engine==='redis'?'':s.activeSessionId??'');setDatabase(selected?.engine==='redis'?'':tab?.sessionId===s.activeSessionId?tab.database:selected?.database??'');setOpened(true);setError('');void loadAnalyses().catch(e=>setError(normalizeError(e).message));};window.addEventListener('dw:analysis',show);return()=>window.removeEventListener('dw:analysis',show);},[]);
 const launch=async(plan:AnalysisPlan)=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');try{const s=useSessionStore.getState(),session=s.sessions.find(v=>v.id===plan.sessionId);if(!session)throw Error('原会话已删除，请新建分析方案');if((plan.source==='mongo')!==(session.engine==='mongodb')||session.engine==='redis')throw Error('该方案的数据源类型与会话引擎不匹配');if(!s.statuses[plan.sessionId]?.connected)await s.connect(plan.sessionId);openAnalysis(structuredClone(plan));setOpened(false);}catch(e){setError(normalizeError(e).message);}finally{lock.current=false;setBusy(false);}};
 const selected=sessions.find(s=>s.id===sessionId),supported=selected&&selected.engine!=='redis';
 return <Dialog open={opened} onOpenChange={(_,d)=>{if(!busy)setOpened(d.open);}}><DialogSurface className="dw-analysis-library"><DialogBody><DialogTitle>数据分析与图表</DialogTitle><DialogContent>

 <div className="dw-analysis-fields"><Field size="small" label="会话"><Select size="small" value={sessionId} disabled={busy} onChange={(_,d)=>{setSessionId(d.value);setDatabase('');}}><option value="">选择会话</option>{sessions.filter(s=>s.engine!=='redis').map(s=><option key={s.id} value={s.id}>{s.name} · {s.engine}</option>)}</Select></Field><Field size="small" label="数据库"><Input size="small" value={database} disabled={busy} onChange={(_,d)=>setDatabase(d.value)}/></Field></div>
 <Button size="small" appearance="primary" icon={<AddRegular/>} disabled={busy||!supported||(!database&&selected?.engine!=='sqlite')} onClick={()=>void launch(newPlan(sessionId,database,selected?.engine==='mongodb'?'mongo':'sql'))}>新建分析</Button>
 <InfoHint label="方案与快照说明">新建和打开方案只进入编辑页，数据在点击“执行 / 刷新分析”后读取。结果页的“用此结果绘图”仅提供一次性快照，不与原查询页联动。</InfoHint><h3>已保存方案（{plans.length}）</h3>{!plans.length&&<p>暂无保存的分析方案</p>}
 <div className="dw-analysis-saved">{plans.map(p=><article key={p.id}><Button size="small" disabled={busy||!sessions.some(s=>s.id===p.sessionId)} icon={<DataBarVerticalRegular/>} onClick={()=>void launch(p)}>{p.name}</Button><small>{sessions.find(s=>s.id===p.sessionId)?.name??'会话已删除'} / {p.database}</small><Button size="small" disabled={busy} icon={<DeleteRegular/>} aria-label={'删除 '+p.name} onClick={()=>setDeleting(p.id)}/>{deleting===p.id&&<><span>仅删除保存的方案？</span><Button size="small" disabled={busy} onClick={()=>{setBusy(true);void deleteAnalysis(p.id).then(()=>setDeleting(null)).catch(e=>setError(normalizeError(e).message)).finally(()=>setBusy(false));}}>确认删除</Button><Button size="small" onClick={()=>setDeleting(null)}>取消</Button></>}</article>)}</div>
 {error&&<p role="alert" className="dw-analysis-error">{error}</p>}{busy&&<Spinner size="small" label="处理中"/>}
 </DialogContent><DialogActions><Button size="small" disabled={busy} onClick={()=>setOpened(false)}>关闭</Button></DialogActions></DialogBody></DialogSurface></Dialog>;
}
