import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Field, Input, Select, Spinner, tokens } from '@fluentui/react-components';
import { save, open } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { api, normalizeError } from '../../ipc';
import type { TableRef } from '../../ipc/types';
import { useSessionStore } from '../../stores/useSessionStore';
import { useTabStore, type SqlExportTab } from '../../stores/useTabStore';
import { usePendingEdit } from '../../stores/useEditGuard';
import { TaskActivity } from '../../app/TaskActivity';
import { SourceFilters } from '../sync/SourceFilters';
import { InfoHint } from '../../common/InfoHint';
import { DEFAULT_SQL_EXPORT, type SqlExportDraft, type SqlExportResult } from './sqlExportModel';

export function SqlExportWorkspace({tab}:{tab:SqlExportTab}) {
 const [draft,setDraft]=useState<SqlExportDraft>({...DEFAULT_SQL_EXPORT,...tab.draft}),[databases,setDatabases]=useState<string[]>([]),[tables,setTables]=useState<TableRef[]>([]),[search,setSearch]=useState(''),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<SqlExportResult|null>(null),[confirmed,setConfirmed]=useState(false);
 const sessions=useSessionStore(s=>s.sessions),statuses=useSessionStore(s=>s.statuses);const locked=useRef(false);const session=sessions.find(s=>s.id===draft.sessionId);const connected=Boolean(statuses[draft.sessionId]?.connected);
 const change=(patch:Partial<SqlExportDraft>)=>{setDraft(d=>({...d,...patch}));setResult(null);setError('');setConfirmed(false);};
 useEffect(()=>{useTabStore.getState().updateSqlExport(tab.id,draft);},[tab.id,draft]);
 useEffect(()=>{let active=true;setDatabases([]);if(!draft.sessionId||!connected)return;void api.listDatabases(draft.sessionId).then(values=>{if(active)setDatabases(values.map(v=>v.name));}).catch(e=>{if(active)setError(normalizeError(e).message);});return()=>{active=false;};},[draft.sessionId,connected]);
 useEffect(()=>{let active=true;setTables([]);if(!draft.sessionId||!draft.database||!connected)return;setLoading(true);void api.listTables(draft.sessionId,draft.database).then(values=>{if(active)setTables(values.filter(t=>t.kind==='table'));}).catch(e=>{if(active)setError(normalizeError(e).message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[draft.sessionId,draft.database,connected]);
 const chosen=draft.allTables?tables.map(t=>t.name):draft.tables.filter(n=>tables.some(t=>t.name===n));const filtered=tables.filter(t=>`${t.name} ${t.comment??''}`.toLowerCase().includes(search.toLowerCase()));
 usePendingEdit({tabId:tab.id,sessionId:draft.sessionId,label:'SQL 文件导出',busy:()=>busy,save:async()=>{},discard:()=>{}},busy);
 const run=async()=>{if(locked.current)return;locked.current=true;setBusy(true);setError('');setResult(null);try{
  const path=draft.splitFiles?await open({directory:true,multiple:false,title:'选择 SQL 导出目录'}):await save({defaultPath:`${draft.database.replace(/[<>:"/\\|?*]/g,'_')||'export'}.sql`,filters:[{name:'SQL 文件',extensions:['sql']}]});
  if(typeof path!=='string')return;
  const response=await api.exportSql({...draft,tables:chosen,filters:Object.fromEntries(Object.entries(draft.filters).filter(([t])=>chosen.includes(t))),path},tab.id);setResult(response);
 }catch(e){setError(normalizeError(e).message);}finally{locked.current=false;setBusy(false);}};
 return <div style={{height:'100%',overflow:'auto',padding:16,boxSizing:'border-box'}}>
  <header style={{display:'flex',alignItems:'center',gap:10,marginBottom:14}}><h2 style={{margin:0,fontSize:20}}>导出 SQL 文件</h2><InfoHint label="SQL 导出说明">仅支持 MySQL 数据表，不含视图、触发器、存储过程、函数及事件。结构保留原始建表定义，显式跨库引用保持原样。生成列不写入 INSERT。导出不会修改源数据库。</InfoHint></header>
  <TaskActivity kind="导出" tabId={tab.id}/>
  <fieldset disabled={busy} style={{border:0,padding:0,margin:0,minWidth:0}}>
   <div style={{display:'flex',gap:12,flexWrap:'wrap'}}>
    <Field label="MySQL 会话" style={{minWidth:220,flex:1}}><Select value={draft.sessionId} onChange={(_,d)=>change({sessionId:d.value,database:'',tables:[],filters:{}})}><option value="">选择会话</option>{sessions.filter(s=>s.engine==='mysql').map(s=><option key={s.id} value={s.id}>{s.name}{statuses[s.id]?.connected?'':'（未连接）'}</option>)}</Select></Field>
    <Field label="数据库" style={{minWidth:220,flex:1}}><Select value={draft.database} disabled={!connected} onChange={(_,d)=>change({database:d.value,tables:[],filters:{}})}><option value="">选择数据库</option>{databases.map(n=><option key={n}>{n}</option>)}</Select></Field>
    {session&&!connected&&<Button onClick={()=>void useSessionStore.getState().connect(session.id).catch(e=>setError(normalizeError(e).message))}>连接</Button>}
   </div>
   <div style={{display:'grid',gridTemplateColumns:'minmax(240px,1fr) minmax(280px,1fr)',gap:20,marginTop:16}}>
    <section><div style={{display:'flex',alignItems:'center',gap:8}}><strong>导出范围</strong><span style={{color:tokens.colorNeutralForeground3}}>已选 {chosen.length} 张表</span></div>
     <Checkbox label="整个数据库的全部数据表" checked={draft.allTables} onChange={(_,d)=>change({allTables:Boolean(d.checked)})}/>
     <Input aria-label="搜索导出表" placeholder="搜索表名或备注" value={search} onChange={(_,d)=>setSearch(d.value)} style={{width:'100%'}}/>
     <div style={{display:'flex',gap:8,marginBlock:8}}><Button size="small" disabled={draft.allTables} onClick={()=>change({tables:[...new Set([...draft.tables,...filtered.map(t=>t.name)])]})}>选择筛选结果</Button><Button size="small" disabled={draft.allTables} onClick={()=>change({tables:[]})}>全不选</Button></div>
     <div style={{height:260,overflowY:'auto',border:`1px solid ${tokens.colorNeutralStroke2}`,borderRadius:6,padding:6}}>
      {loading?<Spinner size="tiny" label="读取数据表…"/>:filtered.map(t=><div key={t.name}><Checkbox disabled={draft.allTables} checked={draft.allTables||draft.tables.includes(t.name)} label={t.name+(t.comment?` · ${t.comment}`:'')} onChange={(_,d)=>change({tables:d.checked?[...draft.tables,t.name]:draft.tables.filter(n=>n!==t.name)})}/></div>)}
      {!loading&&!filtered.length&&<span style={{color:tokens.colorNeutralForeground3}}>暂无数据表</span>}
     </div>
    </section>
    <section style={{display:'flex',flexDirection:'column',gap:12}}>
     <Field label="导出内容"><Select value={draft.mode} onChange={(_,d)=>change({mode:d.value as SqlExportDraft['mode'],...(d.value==='data'?{dropTables:false}:{})})}><option value="structure">仅结构</option><option value="data">仅数据</option><option value="both">结构和数据</option></Select></Field>
     <Field label="输出方式"><Select value={draft.splitFiles?'split':'single'} onChange={(_,d)=>change({splitFiles:d.value==='split'})}><option value="single">单个 SQL 文件</option><option value="split">按表拆分到新文件夹</option></Select></Field>
     <Checkbox checked={draft.includeDatabase} label="包含建库语句和 USE" onChange={(_,d)=>change({includeDatabase:Boolean(d.checked)})}/>
     <Checkbox disabled={draft.mode==='data'} checked={draft.dropTables} label="包含 DROP TABLE（恢复时删除同名表）" onChange={(_,d)=>change({dropTables:Boolean(d.checked)})}/>
     <div><Checkbox disabled={draft.mode==='structure'} checked={draft.consistentSnapshot} label="使用 InnoDB 一致性快照" onChange={(_,d)=>change({consistentSnapshot:Boolean(d.checked)})}/><InfoHint label="快照说明">同一次导出的 InnoDB 数据使用同一快照；不锁定其他客户端的结构操作。关闭后各表可能来自不同时间。非 InnoDB 表需关闭此项；导出期间结构变化会阻止发布文件。</InfoHint></div>
     <details><summary>高级选项</summary><Field label="每条 INSERT 最多行数"><Input type="number" min={1} max={10000} value={String(draft.batchRows)} onChange={(_,d)=>change({batchRows:Number(d.value)})}/></Field><Field label="每条 INSERT 目标大小（KiB）"><Input type="number" min={1} max={16384} value={String(draft.batchBytes/1024)} onChange={(_,d)=>change({batchBytes:Number(d.value)*1024})}/></Field><InfoHint label="批次大小说明">按行数和字节数分批；单行较大时独占一条 INSERT，最大 64 MiB。恢复服务器需允许相应的 max_allowed_packet。</InfoHint></details>
    </section>
   </div>
   {draft.mode!=='structure'&&chosen.length>0&&<div style={{marginTop:16}}><SourceFilters purpose="export" sessionId={draft.sessionId} database={draft.database} tables={chosen} filters={draft.filters} disabled={busy} onChange={filters=>change({filters})}/></div>}
   {draft.dropTables&&<Checkbox checked={confirmed} onChange={(_,d)=>setConfirmed(Boolean(d.checked))} label="我已确认：执行导出文件时，将删除目标库的同名表及其数据。"/>}
   <Button appearance="primary" style={{marginTop:14}} disabled={!connected||!draft.database||!chosen.length||loading||busy||(draft.dropTables&&!confirmed)||!Number.isInteger(draft.batchRows)||draft.batchRows<1||draft.batchRows>10000||draft.batchBytes<1024||draft.batchBytes>16777216} onClick={()=>void run()}>{busy?'导出中…':'选择路径并导出'}</Button>
  </fieldset>
  {error&&<p role="alert" style={{color:tokens.colorPaletteRedForeground1,whiteSpace:'pre-wrap'}}>{error}</p>}
  {result&&<div role="status" style={{marginTop:16}}><p>已导出 {result.tables} 张表 · {result.rows.toLocaleString()} 行 · {(result.bytes/1024/1024).toFixed(2)} MiB</p><p style={{overflowWrap:'anywhere',userSelect:'text'}}>{result.path}</p><Button onClick={()=>void revealItemInDir(result.path).catch(e=>setError(normalizeError(e).message))}>打开所在文件夹</Button></div>}
 </div>;
}
