import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Button,Dialog,DialogSurface,DialogBody,DialogTitle,DialogContent,DialogActions,Field,Select,Spinner,tokens} from '@fluentui/react-components';
import {InfoHint} from '../../common/InfoHint';
import {errorText} from '../../stores/useTaskStore';

interface Stats {databasePath:string;databaseBytes:number;auxiliaryBytes:number;sessionCount:number;historyCount:number;historyLimit:number}
const bytes=(n:number)=>n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(2)} MB`;
export function LocalDataSettings(){
 const [stats,setStats]=useState<Stats|null>(null),[limit,setLimit]=useState('500'),[range,setRange]=useState('30');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[confirm,setConfirm]=useState(false);
 const lock=useRef(false);
 const refresh=async()=>{const data=await invoke<Stats>('local_data_stats');setStats(data);setLimit(String(data.historyLimit));};
 const run=async(action:()=>Promise<void>)=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');setMessage('');try{await action();}catch(e){setError(errorText(e));}finally{lock.current=false;setBusy(false);}};
 useEffect(()=>{void run(refresh);},[]);
 return <section style={{maxWidth:760,display:'flex',flexDirection:'column',gap:20}} aria-label="本机数据">
  {error&&<div role="alert" style={{color:tokens.colorPaletteRedForeground1}}>{error}</div>}
  {message&&<div role="status">{message}</div>}
  <div style={{display:'flex',alignItems:'center',gap:10}}><strong>本地存储</strong><Button size="small" disabled={busy} onClick={()=>void run(refresh)}>刷新</Button>{busy&&<Spinner size="tiny"/>}</div>
  {stats&&<>
   <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))',gap:12}}>
    {[['数据库大小',bytes(stats.databaseBytes)],['辅助文件',bytes(stats.auxiliaryBytes)],['已保存会话',`${stats.sessionCount} 条`],['查询历史',`${stats.historyCount} 条`]].map(([name,value])=><div key={name} style={{border:`1px solid ${tokens.colorNeutralStroke2}`,borderRadius:6,padding:12}}><div style={{color:tokens.colorNeutralForeground3,fontSize:12}}>{name}</div><strong style={{display:'block',marginTop:6,fontSize:20}}>{value}</strong></div>)}
   </div>
   <Field label="本地数据库路径"><code style={{overflowWrap:'anywhere',userSelect:'text'}}>{stats.databasePath}</code></Field>
   <div style={{display:'flex',gap:8,alignItems:'center'}}><span>存储说明</span><InfoHint label="本地数据存储说明">大小仅统计 app.db 与 SQLite 辅助文件，不包含日志。数据库密码单独保存在 Windows 凭据管理器。清理历史不删除会话、收藏的 SQL、草稿或数据库业务数据。</InfoHint></div>
  </>}
  <div style={{display:'flex',flexDirection:'column',gap:10}}>
   <strong>查询历史</strong>
   <div style={{display:'flex',gap:10,alignItems:'end',flexWrap:'wrap'}}>
    <Field label="每个会话保留上限"><Select aria-label="每个会话保留上限" disabled={busy||!stats} value={limit} onChange={e=>setLimit(e.target.value)}>{[500,1000,2000,5000,10000,100000,0].map(n=><option key={n} value={n}>{n?`最近 ${n.toLocaleString()} 条`:'不自动清理'}</option>)}{stats&&![500,1000,2000,5000,10000,100000,0].includes(stats.historyLimit)&&<option value={stats.historyLimit}>{stats.historyLimit} 条</option>}</Select></Field>
    <Button disabled={busy||!stats||String(stats.historyLimit)===limit} onClick={()=>void run(async()=>{await invoke('local_data_set_retention',{limit:Number(limit)});await refresh();setMessage('已保存。各会话下次写入查询历史时按新上限清理。');})}>保存</Button>
    <InfoHint label="历史保留策略">默认每个会话保留最近 500 条。保存后不立即删除；各会话下次新增历史时自动清理超出上限的记录。收藏的 SQL 独立保留。</InfoHint>
   </div>
   <div style={{display:'flex',gap:10,alignItems:'end',flexWrap:'wrap'}}>
    <Field label="手动清理范围"><Select aria-label="手动清理范围" value={range} disabled={busy} onChange={e=>setRange(e.target.value)}>{[7,30,90,180,365].map(n=><option key={n} value={n}>{n} 天前的查询历史</option>)}<option value="all">全部查询历史</option></Select></Field>
    <Button disabled={busy||!stats||stats.historyCount===0} onClick={()=>setConfirm(true)}>清理查询历史…</Button>
   </div>
  </div>
  <div style={{display:'flex',gap:10,alignItems:'center'}}><Button disabled={busy||!stats} onClick={()=>void run(async()=>{await invoke('local_data_compact');await refresh();setMessage('本地数据库空间回收完成。');})}>回收空闲空间</Button><InfoHint label="回收空间说明">删除记录后文件大小可能不变。此操作整理本地 SQLite 数据库，保留现有记录；过程中本地配置写入可能短暂等待，大文件可能需要较长时间。</InfoHint></div>
  <Dialog open={confirm} onOpenChange={(_,d)=>{if(!busy)setConfirm(d.open);}}><DialogSurface><DialogBody><DialogTitle>清理查询历史？</DialogTitle><DialogContent>将删除所有会话中{range==='all'?'的全部查询历史':`${range} 天前的查询历史`}，无法撤销。会话配置、收藏的 SQL 和草稿会保留。</DialogContent><DialogActions><Button disabled={busy} onClick={()=>setConfirm(false)}>取消</Button><Button appearance="primary" disabled={busy} onClick={()=>void run(async()=>{const removed=await invoke<number>('local_data_clear_history',{olderThanDays:range==='all'?null:Number(range)});setConfirm(false);await refresh();setMessage(`已清理 ${removed} 条查询历史。`);})}>确认清理</Button></DialogActions></DialogBody></DialogSurface></Dialog>
 </section>;
}
