import {useEffect,useState} from 'react';
import {Button,Checkbox,Dialog,DialogActions,DialogBody,DialogContent,DialogSurface,DialogTitle,Input,Spinner} from '@fluentui/react-components';
import type {RowChange,DbValue} from '../../ipc/types';
import {api} from '../../ipc';
import {useNotify} from '../../app/toast';
import {useSessionStore} from '../../stores/useSessionStore';
import {useObjectPreferences} from '../../stores/useObjectPreferences';

const valueText=(v:DbValue)=>v[0]==='null'?'NULL':typeof v[1]==='object'?JSON.stringify(v[1]):String(v[1]);
export function DataChangePreview({open,sessionId,database,schema,table,changes,onApply,onClose}:{open:boolean;sessionId:string;database:string;schema?:string|null;table:string;changes:RowChange[];onApply:(indexes:number[])=>Promise<void>;onClose:()=>void}){
 const notify=useNotify();
 const session=useSessionStore(s=>s.sessions.find(v=>v.id===sessionId));
 const production=useObjectPreferences(s=>s.environments[sessionId]==='production');
 const [selected,setSelected]=useState(()=>changes.map((_,i)=>i));
 const [sql,setSql]=useState<string[]>([]);
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [confirmation,setConfirmation]=useState('');
 const [view,setView]=useState<'diff'|'sql'>('diff');
 useEffect(()=>{if(open){setSelected(changes.map((_,i)=>i));setConfirmation('');setView('diff');}},[open]);
 useEffect(()=>{
   if(!open||busy)return;
   let stale=false;setLoading(true);setError('');setConfirmation('');
   if(!selected.length){setSql([]);setLoading(false);return;}
   api.gridPreviewChanges(sessionId,database,schema??null,table,selected.map(i=>changes[i]))
    .then(v=>{if(!stale)setSql(v);}).catch(e=>{if(!stale)setError(String(e));}).finally(()=>{if(!stale)setLoading(false);});
   return ()=>{stale=true;};
 },[open,busy,selected,changes,sessionId,database,schema,table]);
 const submit=async()=>{
   if(!session||session.readOnly||loading||error||!selected.length||(production&&confirmation!==database))return;
   setBusy(true);try{await onApply(selected);onClose();}catch(e){notify.error(e,'提交失败，修改仍保留');}finally{setBusy(false);}
 };
 return <Dialog open={open} onOpenChange={(_,d)=>{if(!d.open&&!busy)onClose();}}><DialogSurface style={{maxWidth:1000,width:'90vw'}}><DialogBody>
 <DialogTitle>提交数据修改 · {database}.{table}</DialogTitle>
 <DialogContent style={{fontSize:12}}>
 <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}>
 <Checkbox size="medium" label={'已选 '+selected.length+' / '+changes.length+' 行'} disabled={busy} checked={selected.length===changes.length?true:selected.length? 'mixed':false} onChange={(_,d)=>setSelected(d.checked?changes.map((_,i)=>i):[])}/>
 <span>新增 {changes.filter(c=>c.kind==='insert').length} · 修改 {changes.filter(c=>c.kind==='update').length} · 删除 {changes.filter(c=>c.kind==='delete').length}</span>
 <Button size="small" appearance={view==='diff'?'primary':'subtle'} onClick={()=>setView('diff')}>修改前后</Button>
 <Button size="small" appearance={view==='sql'?'primary':'subtle'} onClick={()=>setView('sql')}>SQL 预览</Button>
 </div>
 <div style={{maxHeight:'48vh',overflow:'auto',border:'1px solid var(--colorNeutralStroke2)'}}>
 {view==='diff'?changes.map((c,i)=>{
 const fields=c.kind==='update'?c.changes.map(v=>({name:v.column,before:valueText(v.oldValue),after:valueText(v.newValue)})):c.kind==='insert'?c.values.map(v=>({name:v.column,before:'—',after:valueText(v.value)})):(c.before??c.keys).map(v=>({name:v.column,before:valueText(v.value),after:'删除整行'}));
 return <section key={i} style={{borderBottom:'1px solid var(--colorNeutralStroke2)',padding:'4px 8px'}}>
 <Checkbox disabled={busy} checked={selected.includes(i)} label={(i+1)+'. '+({insert:'新增',update:'修改',delete:'删除'}[c.kind])+(c.kind==='insert'?'':' · '+c.keys.map(k=>k.column+'='+valueText(k.value)).join(', '))} onChange={(_,d)=>setSelected(v=>d.checked?[...v,i].sort((a,b)=>a-b):v.filter(n=>n!==i))}/>
 <table style={{width:'100%',tableLayout:'fixed',borderCollapse:'collapse',fontSize:12}}><thead><tr><th style={{width:'24%',textAlign:'left',fontWeight:400}}>字段</th><th style={{textAlign:'left',fontWeight:400}}>修改前</th><th style={{textAlign:'left',fontWeight:400}}>修改后</th></tr></thead><tbody>{fields.map(f=><tr key={f.name}>{[f.name,f.before,f.after].map((v,j)=><td key={j} title={v} style={{padding:'3px 6px',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',color:j===2?'var(--colorBrandForeground1)':undefined}}>{v}</td>)}</tr>)}</tbody></table>
 </section>;
 }):<pre style={{fontSize:12,whiteSpace:'pre-wrap',overflowWrap:'anywhere',padding:8}}>{sql.join(';\n\n')}</pre>}
 </div>
 {loading&&<Spinner size="tiny" label="生成所选变更 SQL…"/>}{error&&<p role="alert">{error}</p>}
 <p>仅提交勾选行，未勾选的修改继续保留。删除项展示已加载的原始值，实际删除整行。</p>
 {production&&<Input size="small" aria-label="生产数据库确认" placeholder={'生产会话：输入数据库名 '+database+' 确认提交'} value={confirmation} onChange={(_,d)=>setConfirmation(d.value)} disabled={busy}/>}
 </DialogContent>
 <DialogActions><Button size="small" disabled={busy} onClick={onClose}>取消</Button><Button size="small" appearance="primary" disabled={!session||session.readOnly||busy||loading||!!error||!selected.length||(production&&confirmation!==database)} onClick={()=>void submit()}>{busy?'提交中…':'提交所选 '+selected.length+' 行'}</Button></DialogActions>
 </DialogBody></DialogSurface></Dialog>;
}
