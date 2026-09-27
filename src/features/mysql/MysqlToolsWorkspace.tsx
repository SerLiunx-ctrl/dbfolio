import {useEffect,useState} from 'react';
import {Button,Field,Select,tokens} from '@fluentui/react-components';
import {api,normalizeError} from '../../ipc';
import {useSessionStore} from '../../stores/useSessionStore';
import {useTabStore,type MysqlToolTab} from '../../stores/useTabStore';
import {SqlImportPanel} from './SqlImportPanel';
import {ObjectsPanel} from './ObjectsPanel';
export function MysqlToolsWorkspace({tab}:{tab:MysqlToolTab}){
 const sessions=useSessionStore(s=>s.sessions),statuses=useSessionStore(s=>s.statuses);const [sessionId,setSessionId]=useState(tab.sessionId),[database,setDatabase]=useState(tab.database),[databases,setDatabases]=useState<string[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const connected=!!statuses[sessionId]?.connected;
 const selectTarget=(id:string,db:string)=>{setSessionId(id);setDatabase(db);setError('');useTabStore.setState(s=>({tabs:s.tabs.map(t=>t.id===tab.id&&t.kind==='mysqlTool'?{...t,sessionId:id,database:db,title:(tab.mode==='import'?'SQL 导入':'数据库对象')+(db?' · '+db:'')}:t)}));useSessionStore.getState().setActiveSession(id);};
 useEffect(()=>{let live=true;setDatabases([]);if(connected)void api.listDatabases(sessionId).then(d=>{if(live)setDatabases(d.map(x=>x.name));}).catch(e=>{if(live)setError(normalizeError(e).message);});return()=>{live=false;};},[sessionId,connected]);
 return <div className="mysql-tools" style={{height:'100%',overflow:'auto',padding:10,boxSizing:'border-box',fontSize:12}}>
 <div style={{display:'flex',gap:8,alignItems:'end',marginBottom:8}}><strong style={{alignSelf:'center',fontSize:14}}>{tab.mode==='import'?'导入 SQL 文件':'数据库对象'}</strong><Field label="MySQL 会话"><Select size="small" disabled={busy} value={sessionId} onChange={(_,d)=>selectTarget(d.value,'')}>{sessions.filter(s=>s.engine==='mysql').map(s=><option value={s.id} key={s.id}>{s.name}{s.readOnly?'（只读）':''}</option>)}</Select></Field><Field label="数据库"><Select size="small" disabled={busy||!connected} value={database} onChange={(_,d)=>selectTarget(sessionId,d.value)}><option value="">选择数据库</option>{databases.map(d=><option key={d}>{d}</option>)}</Select></Field>{!connected&&<Button size="small" onClick={()=>void useSessionStore.getState().connect(sessionId).catch(e=>setError(normalizeError(e).message))}>连接</Button>}</div>
 {error&&<div role="alert" style={{color:tokens.colorPaletteRedForeground1}}>{error}</div>}
 {connected&&database&&(tab.mode==='import'?<SqlImportPanel key={sessionId+database} sessionId={sessionId} database={database} tabId={tab.id} onBusy={setBusy}/>:<ObjectsPanel key={sessionId+database} sessionId={sessionId} database={database} table={tab.table} tabId={tab.id} onBusy={setBusy}/>)}
 </div>;
}
