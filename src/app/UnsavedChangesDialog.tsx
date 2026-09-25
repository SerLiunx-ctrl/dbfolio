import {useObjectPreferences} from '../stores/useObjectPreferences';
import { useEffect, useState } from "react";
import { Input, Button, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Spinner } from "@fluentui/react-components";
import { useEditGuard } from "../stores/useEditGuard";
import { normalizeError } from "../ipc";
import { EnvironmentBadge } from "../features/sessions/EnvironmentBadge";
export function UnsavedChangesDialog() {
 const request=useEditGuard(s=>s.request);
 const environments=useObjectPreferences(s=>s.environments);
 const production=request?.entries.some(e=>(e.preview||e.kind==='transaction')&&environments[e.sessionId]==='production');
 const [confirmation,setConfirmation]=useState('');
 const [busy,setBusy]=useState(false), [error,setError]=useState("");
 const [scripts,setScripts]=useState<string[]>([]),[ready,setReady]=useState(false);
 useEffect(()=>{let active=true;setConfirmation("");setError("");setScripts([]);setReady(false);
 if(request) Promise.all(request.entries.map(e=>e.preview?.() ?? Promise.resolve([])))
 .then(result=>{if(active){setScripts(result.flat());setReady(true);}}).catch(e=>{if(active)setError(normalizeError(e).message);});
 return ()=>{active=false;};},[request]);
 const finish=(ok:boolean)=>{if(!request)return;useEditGuard.setState({request:null});request.resolve(ok);};
 return <Dialog open={!!request} onOpenChange={(_,d)=>{if(!d.open&&!busy)finish(false);}}><DialogSurface><DialogBody>
 <DialogTitle>存在未保存的修改</DialogTitle><DialogContent>
 <p>SQL 保存到原文件或草稿库；数据修改会提交到当前数据库。{request?.entries.some(e=>e.kind==="transaction")?"未结束事务：保存会提交，放弃会回滚。":""}</p>
 <ul>{request?.entries.map(e=><li key={e.tabId+":"+(e.kind??e.label)}>{e.label}<EnvironmentBadge sessionId={e.sessionId}/></li>)}</ul>
 {!!scripts.length&&<><strong>即将提交的修改</strong><pre style={{maxHeight:220,overflow:"auto",whiteSpace:"pre-wrap"}}>{scripts.join(";\n")}</pre></>}
 {!ready&&!error&&<Spinner size="tiny" label="准备修改预览"/>}
 {error&&<p role="alert">{error}</p>}
 {production&&<Input size="small" aria-label="生产写入确认" placeholder="输入 确认生产写入 后继续保存" value={confirmation} onChange={(_,d)=>setConfirmation(d.value)} disabled={busy}/>}
 </DialogContent><DialogActions>
 <Button disabled={busy} onClick={()=>finish(false)}>取消</Button>
 <Button disabled={busy} onClick={async()=>{setBusy(true);setError("");try{for(const e of request?.entries??[])await e.discard();finish(true);}catch(e){setError(normalizeError(e).message);}finally{setBusy(false);}}}>{request?.entries.some(e=>e.kind==="transaction")?"放弃 / 回滚并继续":"放弃修改并继续"}</Button>
 <Button appearance="primary" disabled={busy||!ready||(production&&confirmation!=='确认生产写入')} onClick={async()=>{setBusy(true);setError("");try{for(const e of request?.entries??[])await e.save();finish(true);}catch(e){setError(normalizeError(e).message);}finally{setBusy(false);}}}>{request?.entries.some(e=>e.kind==="transaction")?"保存 / 提交并继续":"保存并继续"}</Button>
 </DialogActions></DialogBody></DialogSurface></Dialog>;
}
