import {sqlRisk,type SqlRisk} from './sqlRisk';
import {streamedSql} from './streamSql';
import {useTabStore} from '../../stores/useTabStore';
import {useEffect,useRef,useState} from 'react';
import {Button,Spinner} from '@fluentui/react-components';
import {DismissRegular} from '@fluentui/react-icons';
import {api,normalizeError} from '../../ipc';
import {generationApi} from '../generation/model';
import {useSessionStore} from '../../stores/useSessionStore';
import {useExplorerStore} from '../../stores/useExplorerStore';
import {usePendingEdit} from '../../stores/useEditGuard';
import {useTaskStore,isTaskActive,cancelTask} from '../../stores/useTaskStore';
import {askQuery,schemaContext,type Reply} from './queryAi';
import {ClarificationDialog,type Answer} from './ClarificationDialog';
import {PromptEditor} from './PromptEditor';
import {InfoHint} from '../../common/InfoHint';
import './query-ai.css';

export function SmartSqlPanel({sessionId,database,tabId,sql,executionError='',onAppend,onClose,disabled=false,visible=true}:{sessionId:string;database:string;tabId:string;sql:string;executionError?:string;onAppend:(sql:string)=>void;onClose:()=>void;disabled?:boolean;visible?:boolean}){
 const [prompt,setPrompt]=useState(''),[busy,setBusy]=useState(false),[phase,setPhase]=useState(''),[error,setError]=useState(''),[output,setOutput]=useState(''),[applied,setApplied]=useState(false),[clarify,setClarify]=useState(false),[answers,setAnswers]=useState<Answer[]>([]),[history,setHistory]=useState<unknown[]>([]);
 const [aiRisk,setAiRisk]=useState<SqlRisk|undefined>();
 const engine=useSessionStore(s=>s.sessions.find(v=>v.id===sessionId)?.engine)??'mysql';
 const risk=sqlRisk(output,engine,aiRisk);
 const appendPending=useRef<string|null>(null),appendRef=useRef(onAppend);appendRef.current=onAppend;
 useEffect(()=>{if(!busy&&!disabled&&appendPending.current!==null){const value=appendPending.current;appendPending.current=null;appendRef.current(value);setApplied(true);}},[busy,disabled,output]);
 const [pending,setPending]=useState<{request:Record<string,unknown>;questions:NonNullable<Reply['candidate']>['questions']}|null>(null);
 const lock=useRef(false),alive=useRef(true),cancelled=useRef(false),text=useRef(''),latest=useRef({sessionId,database});latest.current={sessionId,database};
 const activeTab=useTabStore(s=>s.activeId);
 const connected=useSessionStore(s=>!!s.statuses[sessionId]?.connected),tasks=useTaskStore(s=>s.tasks).filter(t=>t.tabId===tabId&&t.label.startsWith('智能生成')&&isTaskActive(t));
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;cancelled.current=true;for(const t of useTaskStore.getState().tasks.filter(t=>t.tabId===tabId&&t.label.startsWith("智能生成")&&isTaskActive(t)))void cancelTask(t.id).catch(()=>{});};},[tabId]);
 usePendingEdit({tabId,sessionId,label:'智能生成',busy:()=>lock.current,save:async()=>{},discard:()=>{}},busy,tabId+':smart-sql');
 const send=async(continuation?:Record<string,unknown>)=>{
  if(lock.current||!connected||disabled)return;
  lock.current=true;cancelled.current=false;setBusy(true);setAiRisk(undefined);setError('');setOutput('');text.current='';appendPending.current=null;setApplied(false);
  const valid=()=>alive.current&&!cancelled.current&&latest.current.sessionId===sessionId&&latest.current.database===database;
  const timer=setInterval(()=>{if(valid())setOutput(streamedSql(text.current));},80);
  try{
   setPhase('准备上下文');
   const providers=await generationApi.providers(),provider=providers.find(p=>p.isDefault)??providers[0];
   if(!provider?.model)throw Error('请先在首选项中配置默认 AI 服务和模型。');
   let request=continuation;
   if(!request){
    const tables=await api.listTables(sessionId,database),selection=useExplorerStore.getState().selection;
    const combined=(prompt+' '+sql).toLocaleLowerCase();
    const ranked=tables.map(t=>({table:t,score:(combined.includes(t.name.toLocaleLowerCase())?100:0)+(t.comment&&prompt.includes(t.comment)?50:0)+(selection?.sessionId===sessionId&&selection.database===database&&selection.table===t.name?10:0)})).sort((a,b)=>b.score-a.score);
    const selected=ranked.some(v=>v.score)?ranked.filter(v=>v.score).map(v=>v.table):tables.length<=20?tables:[];
    if(!selected.length)throw Error(tables.length?'请在需求中用 @ 引用相关表，避免选错数据范围。':'当前数据库没有可用表。');
    if(selected.length>20)throw Error('本次涉及超过 20 张表，请缩小需求范围。');
    const context=[];
    for(let i=0;i<selected.length;i++){
     if(!valid())return;
     setPhase(`读取结构 ${i+1}/${selected.length}`);
     const t=selected[i],meta=await api.tableDetail(sessionId,database,t.name,t.schema);
     context.push(schemaContext(meta));
     for(const fk of meta.foreignKeys){const related=tables.find(v=>v.name===fk.refTable&&v.schema===t.schema);if(related&&!selected.some(v=>v.name===related.name&&v.schema===related.schema)&&selected.length<20)selected.push(related);}
    }
    request={sessionId,database,providerId:provider.id,model:provider.model,mode:'generate',prompt,context,sql,error:executionError,history,stream:true};
    setPending(null);setAnswers([]);
   }else request={...request,providerId:provider.id,model:provider.model,stream:true};
   if(!valid())return;
   setPhase('正在生成');
   const result=await askQuery(request,e=>{if(!valid())return;if(e.kind==='delta')text.current=(text.current+e.text).slice(0,2*1024*1024);},tabId);
   if(!valid())return;
   setAiRisk(result.candidate.risk);setOutput(result.candidate.sql);setPhase('');
   setHistory(h=>[...h,{role:'user',requirement:request!.prompt},{role:'assistant',...result.candidate}].slice(-8));
   if(result.candidate.questions.length){setPending({request,questions:result.candidate.questions});setAnswers([]);setClarify(true);}else{setPending(null);if(result.validationError)setError(result.validationError);else if(result.candidate.sql.trim())appendPending.current=result.candidate.sql;else setError('模型未返回 SQL，请调整需求后重试。');}
  }catch(e){if(valid()){setOutput(streamedSql(text.current));setError(normalizeError(e).message);}}finally{clearInterval(timer);lock.current=false;if(alive.current){setBusy(false);setPhase('');}}
 };
 const submit=()=>{
  if(!pending)return;
  const requirement=String(pending.request.prompt)+'\n补充回答：'+JSON.stringify(pending.questions.map((q,i)=>({question:typeof q==='string'?q:q.text,selected:answers[i]?.choices??[],answer:answers[i]?.text??''})));
  if(new TextEncoder().encode(requirement).length>16000){setError('需求和回答过长，请缩短内容。');setClarify(false);return;}
  setClarify(false);void send({...pending.request,prompt:requirement});
 };
 return <section className="dw-smart-panel" aria-label="智能生成">
  <header><strong>智能生成</strong><InfoHint label="智能生成说明">使用默认 AI 服务，自动读取相关表结构。输入 @ 补全表名，表名后输入点补全字段；完成后追加 SQL，不自动执行。</InfoHint><span className="dw-smart-header-spacer"/>{busy?<><Spinner size="tiny"/><Button size="small" onClick={()=>{cancelled.current=true;appendPending.current=null;void Promise.all(tasks.map(t=>cancelTask(t.id))).catch(e=>setError(normalizeError(e).message));setError('已停止生成');}}>停止</Button></>:<Button size="small" appearance="primary" disabled={disabled||!connected||!prompt.trim()} onClick={()=>void send()}>生成</Button>}<Button size="small" appearance="transparent" icon={<DismissRegular/>} aria-label="收起智能生成" disabled={busy} onClick={onClose}/></header>
  <PromptEditor sessionId={sessionId} database={database} value={prompt} busy={busy} onChange={value=>{setPrompt(value);setPending(null);setApplied(false);appendPending.current=null;}}/>
  <div className="dw-smart-results">
   <div className="dw-smart-status" role="status">{busy?phase:applied?'已追加，未执行':''}</div>
   {error&&<div role="alert" className="dw-ai-error">{error}{error.includes('配置默认 AI')&&<Button size="small" onClick={()=>window.dispatchEvent(new CustomEvent('dw:settings',{detail:{category:'ai'}}))}>打开首选项</Button>}</div>}
   {pending&&!busy&&<Button size="small" onClick={()=>setClarify(true)}>回答问题（{pending.questions.length}）</Button>}
   {(output||busy)&&<pre className="dw-smart-sql-output" aria-label="生成的 SQL">{output||'等待 SQL…'}</pre>}
  </div>
  {output.trim()&&<footer className={'dw-smart-ai-notice dw-smart-risk-'+risk.level} role={risk.level==='none'?'status':'alert'}>{risk.level!=='none'&&<><strong>{risk.level==='red'?'高风险':'注意风险'}：{risk.reason}</strong><br/></>}内容由 AI 生成，涉及修改的语句请仔细甄别！</footer>}
  {pending&&<ClarificationDialog open={clarify&&visible&&(!activeTab||activeTab===tabId)} questions={pending.questions} answers={answers} onAnswer={(i,a)=>setAnswers(old=>{const next=[...old];next[i]=a;return next;})} onClose={()=>setClarify(false)} onSubmit={submit} blocked={!connected?'连接已断开，请重新连接。':''}/>}
 </section>;
}
