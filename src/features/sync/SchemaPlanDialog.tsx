import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, Spinner, tokens } from '@fluentui/react-components';
import { api } from '../../ipc';
import type { SchemaPlan, SchemaSyncRequest } from '../../ipc/types';
import { useSessionStore } from '../../stores/useSessionStore';
import { EnvironmentBadge } from '../sessions/EnvironmentBadge';
import { TaskActivity } from '../../app/TaskActivity';

export function SchemaPlanDialog({open,visible,tabId,request,onClose,onDone,onLog}:{open:boolean;visible:boolean;tabId?:string;request:SchemaSyncRequest;onClose:()=>void;onDone:()=>void;onLog:(text:string)=>void}) {
  const [plan,setPlan]=useState<SchemaPlan|null>(null),[selected,setSelected]=useState<number[]>([]),[loading,setLoading]=useState(false),[applying,setApplying]=useState(false),[confirmed,setConfirmed]=useState(false),[error,setError]=useState('');
  const [attempt,setAttempt]=useState(0);const lock=useRef(false);const serial=useRef(0);
  const requestRef=useRef(request);requestRef.current=request;
  const [target,setTarget]=useState(request.target);
  const session=useSessionStore(s=>s.sessions.find(v=>v.id===target.sessionId));
  useEffect(()=>{if(!open)return;const id=++serial.current;setPlan(null);setSelected([]);setConfirmed(false);setError('');setLoading(true);const req=structuredClone(requestRef.current);setTarget(req.target);
    void api.syncPreviewSchema(req,tabId).then(p=>{if(id!==serial.current)return;setPlan(p);setSelected(p.statements.map((_,i)=>i));}).catch(e=>{if(id===serial.current)setError(e.message??String(e));}).finally(()=>{if(id===serial.current)setLoading(false);});
    return()=>{serial.current++;};
  },[open,attempt,tabId]);
  const apply=async()=>{if(!plan || lock.current || !session || session.readOnly)return;lock.current=true;setApplying(true);setError('');try{const result=await api.syncExecuteSchema(plan.id,selected,tabId,target.sessionId);onLog(`结构同步：成功 ${result.executed} 条，失败 ${result.failed} 条`);if(result.error){onLog(result.error);setError(result.error);setPlan(null);onDone();}else{onDone();onClose();}}catch(e){setError((e as Error).message??String(e));setPlan(null);onDone();}finally{lock.current=false;setApplying(false);}};
  return <Dialog modalType="non-modal" open={open&&visible} onOpenChange={(_,d)=>{if(!d.open&&!applying)onClose();}}><DialogSurface style={{width:'min(840px,94vw)',maxWidth:840}}><DialogBody>
    <DialogTitle>确认结构同步</DialogTitle><DialogContent style={{maxHeight:'70vh',overflowY:'auto'}}>
      <TaskActivity kind="同步" sessionId={target.sessionId} tabId={tabId}/>
      <p>目标：{session?.name??target.sessionId} / {target.database} <EnvironmentBadge sessionId={target.sessionId}/></p>
      {loading&&<Spinner size="tiny" label="检查结构并生成固定计划…"/>}
      {error&&<p role="alert" style={{color:tokens.colorPaletteRedForeground1,whiteSpace:'pre-wrap'}}>{error}</p>}
      {plan&&<>
        {plan.warnings.length>0&&<div role="status" style={{padding:10,background:tokens.colorPaletteYellowBackground1,color:tokens.colorPaletteYellowForeground2}}><strong>以下差异不会自动处理</strong><ul>{plan.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></div>}
        {plan.groups.map((group,n)=>{const tables=[...new Set(group.map(i=>plan.statements[i].table))];return <section key={n} style={{marginBlock:12,border:`1px solid ${tokens.colorNeutralStroke2}`,borderRadius:6,padding:8}}>
          <Checkbox disabled={applying} checked={group.every(i=>selected.includes(i))} label={`${tables.join('、')} · ${group.length} 条${tables.length>1?'（依赖操作组）':''}`} onChange={(_,d)=>{setSelected(old=>d.checked?[...new Set([...old,...group])]:old.filter(i=>!group.includes(i)));setConfirmed(false);}}/>
          {group.map(i=><details key={i} style={{padding:'4px 8px'}} open={plan.statements.length<=3}><summary>{plan.statements[i].description}</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12,padding:10,background:tokens.colorNeutralBackground3}}>{plan.statements[i].sql}</pre></details>)}
        </section>})}
        {!plan.statements.length&&<p>当前选项下没有可执行的结构变更。</p>}
        {plan.statements.length>0&&<Checkbox disabled={applying} checked={confirmed} onChange={(_,d)=>setConfirmed(Boolean(d.checked))} label="确认修改目标结构；失败或取消时，已执行的变更不会自动撤销。"/>}
      </>}
    </DialogContent><DialogActions>
      <Button disabled={loading||applying} onClick={()=>setAttempt(v=>v+1)}>重新预览</Button>
      <Button disabled={applying} onClick={onClose}>关闭</Button>
      <Button appearance="primary" title={session?.readOnly?"目标会话为只读":undefined} disabled={!session||session.readOnly||!plan||!selected.length||!confirmed||loading||applying} onClick={()=>void apply()}>{applying?'执行中…':`执行所选${selected.length?`（${selected.length}）`:''}`}</Button>
    </DialogActions></DialogBody></DialogSurface></Dialog>;
}
