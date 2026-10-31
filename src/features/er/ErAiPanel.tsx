import {useEffect,useRef,useState} from 'react';
import {Button,Checkbox,Select,Textarea,Spinner} from '@fluentui/react-components';
import {DismissRegular,SparkleRegular} from '@fluentui/react-icons';
import {generationApi,type Provider} from '../generation/model';
import {trackedInvoke} from '../../ipc/taskInvoke';
import {cancelTask,errorText,isTaskActive,useTaskStore} from '../../stores/useTaskStore';
import type {ErTab} from '../../stores/useTabStore';
import type {ErTable,Relation} from './model';
import {confidenceLabel,type AiReply,type AiRequest,type AiVerified} from './ai';

export function ErAiPanel({tab,tables,manual,visible,busy,onClose,onLocate,onAdopt}:{tab:ErTab;tables:ErTable[];manual:Relation[];visible:boolean;busy:boolean;onClose:()=>void;onLocate:(id:string)=>void;onAdopt:(result:AiVerified)=>void}){
 const [providers,setProviders]=useState<Provider[]>([]),[provider,setProvider]=useState(''),[selected,setSelected]=useState<string[]>(()=>tables.length<=20?tables.map(t=>t.key):[]),[instruction,setInstruction]=useState(''),[loading,setLoading]=useState(true),[working,setWorking]=useState(false),[error,setError]=useState(''),[reply,setReply]=useState<AiReply|null>(null),[chosen,setChosen]=useState<number[]>([]),[notice,setNotice]=useState('');
 const snapshot=useRef<{request:AiRequest;signature:string}|null>(null),alive=useRef(true),cancelled=useRef(false),task=useTaskStore(s=>s.tasks.find(t=>t.tabId===tab.id&&t.label.startsWith('ER ')&&isTaskActive(t)));
 const signature=JSON.stringify([provider,selected.slice().sort(),instruction,tables.map(t=>t.key).sort()]);
 const latest=useRef({signature,manual,busy,onAdopt});latest.current={signature,manual,busy,onAdopt};
 const load=async()=>{setLoading(true);setError('');try{const list=await generationApi.providers();if(alive.current){setProviders(list);setProvider(v=>list.some(p=>p.id===v)?v:(list.find(p=>p.isDefault)??list[0])?.id??'');}}catch(e){if(alive.current)setError(errorText(e));}finally{if(alive.current)setLoading(false);}};
 useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;cancelled.current=true;for(const t of useTaskStore.getState().tasks.filter(t=>t.tabId===tab.id&&t.label.startsWith('ER ')&&isTaskActive(t)))void cancelTask(t.id);};},[tab.id]);
 useEffect(()=>{if(cancelled.current&&task)void cancelTask(task.id);},[task?.id]);
 const invokeAi=async<T,>(command:string,args:Record<string,unknown>)=>{
  const requested=new Set<string>();
  const unsubscribe=useTaskStore.subscribe(s=>{if(cancelled.current||!alive.current)for(const t of s.tasks.filter(t=>t.tabId===tab.id&&t.label.startsWith('ER ')&&t.status==='running'&&!requested.has(t.id))){requested.add(t.id);void cancelTask(t.id);}});
  try{return await trackedInvoke<T>(command,args);}finally{unsubscribe();}
 };
 const stop=()=>{cancelled.current=true;if(task)void cancelTask(task.id);};
 const start=async()=>{if(!provider||busy||!selected.length||selected.length>20)return;cancelled.current=false;setWorking(true);setError('');setNotice('');const sig=signature;
  const request:AiRequest={sessionId:tab.sessionId,database:tab.database,providerId:provider,instruction,tables:tables.filter(t=>selected.includes(t.key)).map(t=>({name:t.name,schema:t.schema??null})),existing:manual.map(({from,to,columns,refColumns})=>({from,to,columns,refColumns}))};
  try{const result=await invokeAi<AiReply>('er_ai_suggest',{request,originTabId:tab.id});if(alive.current&&!cancelled.current&&latest.current.signature===sig){snapshot.current={request,signature:sig};setReply(result);setChosen([]);setNotice(result.checked.candidates.length?'请选择需要加入的业务关联':'没有发现新的有效关联，可调整范围或补充业务说明');}else if(alive.current)setNotice('已停止或范围已变化，本次结果未采用');}
  catch(e){if(alive.current)setError(errorText(e));}finally{if(alive.current)setWorking(false);}
 };
 const adopt=async()=>{const previous=snapshot.current;if(!reply||!previous||previous.signature!==signature||busy)return;cancelled.current=false;setWorking(true);setError('');
  const existing=latest.current.manual.map(({from,to,columns,refColumns})=>({from,to,columns,refColumns}));
  try{const result=await invokeAi<AiVerified>('er_ai_verify',{request:{request:{...previous.request,existing},fingerprint:reply.fingerprint,candidates:reply.checked.candidates.filter((_,i)=>chosen.includes(i))},sessionId:tab.sessionId,originTabId:tab.id});if(!alive.current||cancelled.current)return;if(latest.current.signature!==previous.signature||latest.current.busy)throw Error('范围正在变化，请等待加载完成后重试');latest.current.onAdopt(result);setReply(v=>v?{...v,checked:{...v.checked,candidates:v.checked.candidates.filter((_,i)=>!chosen.includes(i))}}:v);setChosen([]);setNotice(`已核对并加入 ${result.checked.candidates.length} 条业务标注，点击关系图“保存”后保留；重复 ${result.checked.duplicates} 条，无效 ${result.checked.rejected} 条`);}
  catch(e){if(alive.current)setError(errorText(e));}finally{if(alive.current)setWorking(false);}
 };
 const stale=!!reply&&snapshot.current?.signature!==signature;
 const name=(id:string)=>{const t=tables.find(t=>t.key===id);return t?(t.schema?t.schema+'.':'')+t.name:'范围外的表';};
 return <aside className="dw-er-ai" aria-label="AI 识别关联" hidden={!visible}>
  <header className="dw-er-ai-header"><div className="dw-er-ai-row"><strong><SparkleRegular/> AI 识别关联</strong>{working&&<Button size="small" disabled={task?.status==='cancelling'} onClick={stop}>停止</Button>}<Button size="small" appearance="subtle" icon={<DismissRegular/>} aria-label="关闭 AI 识别" onClick={onClose}/></div>{reply&&<div className="dw-er-ai-row"><Button size="small" appearance="primary" disabled={!chosen.length||working||busy||stale} onClick={()=>void adopt()}>加入业务标注 · {chosen.length}</Button><Checkbox size="medium" label="全选候选" disabled={working||stale} checked={chosen.length>0&&chosen.length===reply.checked.candidates.length} onChange={(_,d)=>setChosen(d.checked?reply.checked.candidates.map((_,i)=>i):[])}/></div>}</header>
  <div className="dw-er-ai-content"><details className="dw-er-ai-settings" open={!reply}><summary>识别设置 · {selected.length} 张表</summary>
  <small>仅发送所选表的名称、字段类型、注释及键结构，不读取数据行。候选经你选择后加入本地标注，不创建外键。</small>
  <label>AI 服务<div className="dw-er-ai-row"><Select size="small" aria-label="ER AI 服务" value={provider} disabled={working||loading} onChange={(_,d)=>setProvider(d.value)}><option value="">选择 AI 服务</option>{providers.map(p=><option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}</Select><Button size="small" disabled={working||loading} onClick={()=>void load()}>刷新</Button></div></label>
  {!loading&&!providers.length&&<div>尚未配置 AI 服务。<Button size="small" onClick={()=>window.dispatchEvent(new CustomEvent('dw:settings',{detail:{category:'ai'}}))}>配置 AI 服务</Button></div>}
  <details open={!reply}><summary>识别范围 · {selected.filter(k=>tables.some(t=>t.key===k)).length}/20 张表（当前画布）</summary><div className="dw-er-ai-scope">{tables.map(t=><Checkbox key={t.key} size="medium" label={(t.schema?t.schema+'.':'')+t.name} checked={selected.includes(t.key)} disabled={working||(!selected.includes(t.key)&&selected.length>=20)} onChange={(_,d)=>setSelected(v=>d.checked?[...v,t.key]:v.filter(k=>k!==t.key))}/>)}</div><Button size="small" disabled={working} onClick={()=>setSelected(tables.length<=20?tables.map(t=>t.key):[])}>{tables.length<=20?'选择全部':'清空选择（最多 20 张）'}</Button></details>
  <Textarea size="small" aria-label="关联识别补充要求" placeholder="可补充业务含义，例如 owner_id 对应 users.id" maxLength={2000} value={instruction} disabled={working} onChange={(_,d)=>setInstruction(d.value)}/>
  <div className="dw-er-ai-row"><Button size="small" appearance="primary" disabled={!provider||loading||working||busy||!selected.length||selected.some(k=>!tables.some(t=>t.key===k))} onClick={()=>void start()}>开始识别（发送结构）</Button>{working&&<><Spinner size="tiny"/></>}</div>
  </details>
  {task?.progress&&working&&<small role="status">{task.progress.message}</small>}
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {reply&&<><div className="dw-er-ai-row"><strong>候选 · {reply.checked.candidates.length}</strong><small>已过滤：无效 {reply.checked.rejected} · 重复 {reply.checked.duplicates}</small></div><small>置信度为模型判断，未校验实际数据。{reply.usage.inputTokens!==null&&`输入 ${reply.usage.inputTokens} / 输出 ${reply.usage.outputTokens??'未知'} token`}</small>{stale&&<p role="alert">范围或要求已改变，请重新识别。</p>}
   <div className="dw-er-ai-candidates">{reply.checked.candidates.map((c,i)=><article key={i} className="dw-er-ai-candidate"><div className="dw-er-ai-row"><Checkbox size="medium" label={c.name} checked={chosen.includes(i)} disabled={working||stale} onChange={(_,d)=>setChosen(v=>d.checked?[...v,i]:v.filter(n=>n!==i))}/><span className={'dw-er-ai-confidence '+c.confidence}>模型置信：{confidenceLabel(c.confidence)}</span></div><div className="dw-er-mapping"><button onClick={()=>onLocate(c.from)}>{name(c.from)} ({c.columns.join(', ')})</button><span>→</span><button onClick={()=>onLocate(c.to)}>{name(c.to)} ({c.refColumns.join(', ')})</button></div><p>{c.reason}</p>{c.warnings.map((s,n)=><small key={n}>{s}</small>)}</article>)}</div>
   </>}
  </div>
 </aside>;
}
