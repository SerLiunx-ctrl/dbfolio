import {InfoHint} from '../../common/InfoHint';
import { openAnalysis } from "../analysis/AnalysisWorkspace";
import { newPlan } from "../analysis/model";
import {useEffect,useRef,useState,useMemo} from 'react';
import {Button,Input,Field,Spinner,Dialog,DialogSurface,DialogBody,DialogTitle,DialogContent,DialogActions} from '@fluentui/react-components';
import {DataBarVerticalRegular,AddRegular,ArrowClockwiseRegular,DeleteRegular,CopyRegular,SaveRegular,SearchRegular,StarRegular} from '@fluentui/react-icons';
import {useTabStore,type MongoTab} from '../../stores/useTabStore';
import {useSessionStore} from '../../stores/useSessionStore';
import {confirmEdits,usePendingEdit} from '../../stores/useEditGuard';
import {useNotify} from '../../app/toast';
import {normalizeError} from '../../ipc';
import {ValueEditor} from '../grid/ValueEditor';
import {mongo,type MongoQuery,type MongoRow} from './api';
import {MongoTools} from './MongoTools';
import {loadMongoHistory,useMongoHistory,addMongoHistory,starMongoHistory} from './history';
const INITIAL:MongoQuery={filter:'{}',projection:'{}',sort:'{"_id":1}',limit:1000};
function pretty(text:string){return JSON.stringify(JSON.parse(text),null,2);}
function summary(value:unknown){if(value===undefined)return '〈字段不存在〉';if(value===null)return 'null';return typeof value==='string'?value:JSON.stringify(value);}
function JsonTree({value,label='文档'}:{value:unknown;label?:string}){
 if(value===null||typeof value!=='object')return <div><strong>{label}：</strong><span>{summary(value)}</span></div>;
 const entries=Object.entries(value);return <details><summary>{label} · {Array.isArray(value)?'数组':'对象'}（{entries.length}）</summary><div style={{paddingLeft:14}}>{entries.slice(0,200).map(([key,v])=><JsonTree key={key} label={key} value={v}/>)}{entries.length>200&&<p>树视图仅展开前 200 项，完整数据请查看 JSON。</p>}</div></details>;
}
export function MongoWorkspace({tab}:{tab:MongoTab}){
 const active=useTabStore(s=>s.activeId===tab.id);
 const [uncertain,setUncertain]=useState(false);
 const notify=useNotify(), session=useSessionStore(s=>s.sessions.find(v=>v.id===tab.sessionId)),connected=useSessionStore(s=>s.statuses[tab.sessionId]);
 const [query,setQuery]=useState<MongoQuery>(INITIAL),[rows,setRows]=useState<MongoRow[]>([]),[cursor,setCursor]=useState<string|null>(null),[page,setPage]=useState(1),[busy,setBusy]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const [previewIndex,setPreviewIndex]=useState<number|null>(null);
 const [selected,setSelected]=useState<string|null>(null),[original,setOriginal]=useState<string|null>(null),[draft,setDraft]=useState(''),[creating,setCreating]=useState(false),[view,setView]=useState<'table'|'tree'>('table'),[confirm,setConfirm]=useState<'save'|'delete'|null>(null),[historyOpen,setHistoryOpen]=useState(false);
 const seq=useRef(0),mounted=useRef(true),cursorRef=useRef<string|null>(null),writing=useRef(false);
 const history=useMongoHistory(s=>s.items).filter(i=>i.sessionId===tab.sessionId&&i.database===tab.database&&i.collection===tab.collection);
 const originalText=useMemo(()=>original===null?"":pretty(original),[original]);
 const dirty=creating||original!==null&&draft!==originalText;
 const editable=!!connected&&!session?.readOnly&&(creating||original!==null);
 const clear=()=>{setPreviewIndex(null);setUncertain(false);setCreating(false);setOriginal(null);setDraft('');setSelected(null);};
 const release=()=>{const old=cursorRef.current;cursorRef.current=null;setCursor(null);if(old)void mongo.release(tab.sessionId,old).catch(()=>{});};
 const accept=async(result:{rows:MongoRow[];cursor:string|null},token:number)=>{if(!mounted.current||token!==seq.current){if(result.cursor)void mongo.release(tab.sessionId,result.cursor).catch(()=>{});return;}cursorRef.current=result.cursor;setCursor(result.cursor);setRows(result.rows);clear();};
 const run=async()=>{
  if(writing.current||!connected||!await confirmEdits(e=>e.tabId===tab.id))return;
  const token=++seq.current;release();setBusy(true);setError('');
  try{for(const text of [query.filter,query.projection,query.sort]){const value=JSON.parse(text);if(!value||Array.isArray(value)||typeof value!=='object')throw Error('查询条件、字段与排序必须是 JSON 对象');}
   const result=await mongo.find(tab.sessionId,tab.database,tab.collection,query);await accept(result,token);if(token===seq.current){setPage(1);void addMongoHistory({sessionId:tab.sessionId,database:tab.database,collection:tab.collection,query:{...query}}).catch(e=>notify.error(e,'查询成功，保存历史失败'));}
  }catch(e){if(token===seq.current)setError(normalizeError(e).message);}finally{if(token===seq.current)setBusy(false);}
 };
 useEffect(()=>{mounted.current=true;void loadMongoHistory().catch(e=>notify.error(e));return()=>{mounted.current=false;seq.current++;if(cursorRef.current)void mongo.release(tab.sessionId,cursorRef.current).catch(()=>{});};},[tab.sessionId,notify]);
 useEffect(()=>{if(active&&connected&&!rows.length&&!dirty)void run();},[connected,active]);
 const next=async()=>{if(!cursor||busy||!await confirmEdits(e=>e.tabId===tab.id))return;const token=++seq.current;setBusy(true);setError('');try{await accept(await mongo.next(tab.sessionId,cursor),token);if(token===seq.current)setPage(p=>p+1);}catch(e){if(token===seq.current){setError(normalizeError(e).message);release();}}finally{if(token===seq.current)setBusy(false);}};
 const choose=async(row:MongoRow,index:number)=>{
  if(row.id!==null&&row.id===selected)return;
  if(busy||writing.current||!await confirmEdits(e=>e.tabId===tab.id))return;const token=++seq.current;setBusy(true);setError('');
  try{if(row.id===null){clear();setPreviewIndex(index);setDraft(pretty(row.json));return;}const full=await mongo.document(tab.sessionId,tab.database,tab.collection,row.id);if(token!==seq.current)return;setUncertain(false);setSelected(row.id);setOriginal(full);setDraft(pretty(full));setCreating(false);}catch(e){if(token===seq.current)setError(normalizeError(e).message);}finally{if(token===seq.current)setBusy(false);}
 };
 const save=async()=>{
  if(uncertain)throw Error('写入结果待确认，请先复制草稿并刷新查询核对');if(writing.current)throw Error('正在保存');if(!editable)throw Error('当前不可编辑');
  // 本地验证不改变 canonical 数值字符串；最终类型校验在 Rust 完成。
  JSON.parse(draft);writing.current=true;setSaving(true);setError('');
  try{const result=await mongo.write(tab.sessionId,tab.database,tab.collection,creating?'insert':'replace',original,draft);setOriginal(result);setDraft(pretty(result));setCreating(false);const id=JSON.stringify(JSON.parse(result)._id);setSelected(id);setRows(old=>{const row={id,json:result.length>128*1024?"{}":result,truncated:result.length>128*1024};return old.some(r=>r.id===id)?old.map(r=>r.id===id?row:r):[row,...old].slice(0,50);});setConfirm(null);}
  catch(e){if(normalizeError(e).code==='E_WRITE_UNCERTAIN')setUncertain(true);setError(normalizeError(e).message);throw e;}finally{writing.current=false;setSaving(false);}
 };
 usePendingEdit({tabId:tab.id,sessionId:tab.sessionId,label:`MongoDB · ${tab.database}.${tab.collection}`,save,discard:()=>{if(original){setDraft(pretty(original));setCreating(false);}else clear();},busy:()=>writing.current,preview:async()=>[`${creating?'新增':'替换'}文档 ${tab.database}.${tab.collection}\n修改前：\n${original?pretty(original):'（无）'}\n修改后：\n${draft}`]},dirty);
 const add=async(copy=false)=>{if(!session||session.readOnly||busy||saving||!await confirmEdits(e=>e.tabId===tab.id))return;const value=copy&&original?JSON.parse(original):{};delete value._id;value._id={$oid:Math.floor(Date.now()/1000).toString(16).padStart(8,'0')+Array.from(crypto.getRandomValues(new Uint8Array(8)),b=>b.toString(16).padStart(2,'0')).join('')};setUncertain(false);setOriginal(null);setDraft(JSON.stringify(value,null,2));setCreating(true);setSelected(null);};
 const remove=async()=>{if(!session||session.readOnly||!original||writing.current)return;writing.current=true;setSaving(true);try{await mongo.write(tab.sessionId,tab.database,tab.collection,'delete',original,'{}');setRows(rs=>rs.filter(r=>r.id!==selected));clear();setConfirm(null);}catch(e){if(normalizeError(e).code==='E_WRITE_UNCERTAIN')setUncertain(true);setError(normalizeError(e).message);}finally{writing.current=false;setSaving(false);}};
 const parsed=useMemo(()=>rows.map(row=>({...row,value:JSON.parse(row.json)})),[rows]);const columns=useMemo(()=>[...new Set(parsed.flatMap(row=>Object.keys(row.value)))].slice(0,20),[parsed]);
 return <div className="dw-mongo-workspace">
 <header className="dw-table-heading"><strong>{tab.database}.{tab.collection}</strong><span>MongoDB 文档</span>{session?.readOnly&&<span>只读会话</span>}<Button style={{marginLeft:"auto"}} icon={<DataBarVerticalRegular/>} title="新建独立聚合分析，不使用当前文档列表的筛选或结果" onClick={()=>{const plan=newPlan(tab.sessionId,tab.database,"mongo");plan.collection=tab.collection;plan.name=(tab.collection+" 分析").slice(0,120);openAnalysis(plan);}}>新建分析</Button><span><MongoTools tab={tab} readOnly={!!session?.readOnly} filter={query.filter} disabled={!connected||busy||saving}/></span></header>
 <div className="dw-mongo-query">{(['filter','projection','sort'] as const).map((key,index)=><Field key={key} label={['查询 Filter','返回字段 Projection（0/1）','排序 Sort（1/-1）'][index]}><textarea aria-label={key} spellCheck={false} onKeyDown={e=>{if(e.ctrlKey&&e.key==="Enter"&&!busy&&!saving){e.preventDefault();void run();}}} value={query[key]} onChange={e=>setQuery({...query,[key]:e.target.value})} /></Field>)}<Field label="最多读取"><Input type="number" min={1} max={10000} value={String(query.limit)} onChange={(_,d)=>setQuery({...query,limit:Math.max(1,Math.min(10000,Number(d.value)||1))})}/></Field></div>
 <div className="dw-data-toolbar dw-mongo-actions"><Button appearance="primary" icon={<SearchRegular/>} disabled={busy||saving||!connected} onClick={()=>void run()}>查询 / 首批</Button><Button icon={<ArrowClockwiseRegular/>} disabled={busy||saving||!connected} onClick={()=>void run()}>刷新</Button><Button onClick={()=>setHistoryOpen(!historyOpen)}>历史与收藏</Button><Button disabled={!connected||session?.readOnly||busy||saving} icon={<AddRegular/>} onClick={()=>void add()}>新增文档</Button><Button icon={<AddRegular/>} disabled={!connected} onClick={()=>window.dispatchEvent(new CustomEvent("dw:generation",{detail:{sessionId:tab.sessionId,database:tab.database,object:tab.collection}}))}>数据生成</Button><Button onClick={()=>setView(view==='table'?'tree':'table')}>{view==='table'?'JSON 树视图':'表格视图'}</Button>{busy&&<><Spinner size="tiny"/><Button onClick={()=>{++seq.current;setBusy(false);release();}}>停止等待</Button></>}</div>
 {historyOpen&&<div className="dw-mongo-history">{history.length===0?'暂无查询历史':history.map(item=><div key={item.id}><Button size="small" icon={<StarRegular/>} onClick={()=>void starMongoHistory(item.id).catch(e=>notify.error(e))}>{item.favorite?'已收藏':'收藏'}</Button><Button appearance="subtle" onClick={()=>{setQuery({...item.query});setHistoryOpen(false);}}>{new Date(item.at).toLocaleString()} · {item.query.filter.slice(0,120)}</Button></div>)}</div>}
 {error&&<div className="dw-mongo-error" role="alert">{error}</div>}
 <div className="dw-mongo-body"><section className="dw-mongo-results">
 {view==='table'?<div className="dw-mongo-scroll"><table><thead><tr><th>#</th>{columns.map(c=><th key={c}>{c}</th>)}</tr></thead><tbody>{parsed.map((row,i)=><tr key={i} tabIndex={busy||saving?-1:0} aria-label={`文档 ${i+1}，按 Enter 查看详情`} aria-disabled={busy||saving} aria-selected={row.id!==null?row.id===selected:previewIndex===i} onClick={()=>void choose(row,i)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();void choose(row,i);}}}><td>{i+1}{row.truncated&&<span> · 大文档</span>}{row.id===null&&<span> · 投影预览</span>}</td>{columns.map(c=><td key={c} title={summary(row.value[c])}><span>{row.truncated?'〈预览省略，点击行读取〉':summary(row.value[c])}</span></td>)}</tr>)}</tbody></table></div>:<div className="dw-mongo-scroll">{parsed.map((row,i)=><article key={i} tabIndex={busy||saving?-1:0} aria-label={`文档 ${i+1}，按 Enter 查看详情`} aria-disabled={busy||saving} onClick={event=>{if(!(event.target as HTMLElement).closest('summary'))void choose(row,i);}} onKeyDown={event=>{if(event.target===event.currentTarget&&(event.key==='Enter'||event.key===' ')){event.preventDefault();void choose(row,i);}}}><strong>文档 {i+1}</strong>{row.truncated?<p>大文档预览已省略，点击读取完整文档</p>:<JsonTree value={row.value}/>}</article>)}</div>}
 {!rows.length&&!busy&&<p>没有文档。可调整查询条件后重试。</p>}<footer>第 {page} 批 · {rows.length} 条 · 每批最多 50 条<Button size="small" disabled={!cursor||busy||saving||!connected} onClick={()=>void next()}>下一批</Button></footer>
 </section><section className="dw-mongo-detail"><header><strong>{creating?'新增文档':'文档详情'}</strong>{dirty&&<span>未保存</span>}</header>
 {draft?<><InfoHint label="文档编辑说明">Extended JSON 保留 ObjectId、长整数、日期等类型。_id 不可修改。投影查询点击行时会重新读取完整原文。</InfoHint><ValueEditor text={draft} onChange={setDraft} readOnly={!editable||saving}/><div className="dw-mongo-actions"><Button icon={<SaveRegular/>} appearance="primary" disabled={!editable||!dirty||saving||busy||uncertain} onClick={()=>setConfirm('save')}>保存</Button><Button icon={<CopyRegular/>} disabled={!original||session?.readOnly||saving||busy} onClick={()=>void add(true)}>复制为新文档</Button><Button icon={<DeleteRegular/>} disabled={!original||!editable||saving||busy||dirty||uncertain} onClick={()=>setConfirm('delete')}>删除文档</Button></div></>:<p>选择文档查看详情</p>}
 </section></div>
 <Dialog open={confirm!==null} onOpenChange={(_,d)=>{if(!d.open&&!saving)setConfirm(null);}}><DialogSurface style={{maxWidth:1000,width:'90vw'}}><DialogBody><DialogTitle>{confirm==='delete'?'确认删除文档':'确认文档变更'}</DialogTitle><DialogContent><p>{tab.database}.{tab.collection} · 保存时将检查原文是否发生变化。</p><div className="dw-mongo-diff"><section><strong>修改前</strong><pre>{original?pretty(original):'（新文档）'}</pre></section><section><strong>{confirm==='delete'?'删除后':'修改后'}</strong><pre>{confirm==='delete'?'（文档将删除）':draft}</pre></section></div>{error&&<p role="alert">{error}</p>}</DialogContent><DialogActions><Button disabled={saving} onClick={()=>setConfirm(null)}>取消</Button><Button appearance="primary" disabled={!session||session.readOnly||saving||uncertain} onClick={()=>void (confirm==='delete'?remove():save().catch(()=>{}))}>{saving?'处理中…':'确认提交'}</Button></DialogActions></DialogBody></DialogSurface></Dialog>
 </div>;
}
