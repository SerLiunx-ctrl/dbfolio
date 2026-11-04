import {useEffect,useRef,useState} from 'react';
import {Button,Checkbox,Input,Select,Spinner,TableHeader,TableRow,TableBody,TableCell} from '@fluentui/react-components';
import {AddRegular,ArrowClockwiseRegular,ArrowUndoRegular,CodeRegular,CopyRegular,DeleteRegular,EditRegular,FlashRegular,SaveRegular,SearchRegular} from '@fluentui/react-icons';
import Editor from '@monaco-editor/react';
import {api,normalizeError} from '../../ipc';
import {useEditorTheme} from '../../useEditorTheme';
import {useSessionStore} from '../../stores/useSessionStore';
import {useTabStore,type TriggerTab} from '../../stores/useTabStore';
import {confirmEdits,usePendingEdit} from '../../stores/useEditGuard';
import {updateDraft} from '../../stores/useWorkspace';
import {useShortcut} from '../../app/shortcuts';
import {ConfirmSqlDialog} from '../table/ConfirmSqlDialog';
import {ResizableSchemaTable,ResizableHeaderCell} from '../table/ResizableSchemaTable';
import {newTriggerDraft,targetKey,targetLabel,triggerApi,triggerKey,type TriggerCatalog,type TriggerChange,type TriggerDefinition,type TriggerDraft,type TriggerItem,type TriggerTarget} from './model';
import './triggers.css';

type Working={name:string;target:string;draft:TriggerDraft};
const emptyCatalog:TriggerCatalog={items:[],functions:[],engine:'',version:''};
export function TriggersWorkspace({tab,active}:{tab:TriggerTab;active:boolean}){
 const session=useSessionStore(s=>s.sessions.find(v=>v.id===tab.sessionId)),theme=useEditorTheme();
 const [catalog,setCatalog]=useState<TriggerCatalog>(emptyCatalog),[targets,setTargets]=useState<TriggerTarget[]>([]),[selected,setSelected]=useState<TriggerItem|null>(null),[definition,setDefinition]=useState<TriggerDefinition|null>(null);
 const [working,setWorking]=useState<Working|null>(null),[baseline,setBaseline]=useState(''),[editing,setEditing]=useState(false),[search,setSearch]=useState(''),[busy,setBusy]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [pending,setPending]=useState<TriggerChange|null>(null),[warning,setWarning]=useState('');
 const previewRequest=useRef(pending);previewRequest.current=pending;
 const alive=useRef(true),lock=useRef(false),epoch=useRef(0),latest=useRef({working,definition,selected,targets});latest.current={working,definition,selected,targets};
 const readOnly=!session||session.readOnly,restricted=session?.engine==='mysql'&&session.allowedDatabases!=null,canWrite=!readOnly&&!restricted;
 const dirty=editing&&!!working&&JSON.stringify(working)!==baseline;
 const allowedTarget=(t:TriggerTarget)=>!tab.table||(t.name===tab.table&&(t.schema??null)===(tab.schema??null));
 const currentTarget=targets.find(t=>targetKey(t)===working?.target);
 const items=catalog.items.filter(t=>(!tab.table||(t.table===tab.table&&(t.schema??null)===(tab.schema??null)))&&`${t.name} ${t.schema??''} ${t.table} ${t.timing} ${t.event}`.toLowerCase().includes(search.toLowerCase()));
 const fail=(e:unknown)=>{if(alive.current)setError(normalizeError(e).message);};
 const run=async(work:()=>Promise<void>)=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await work();}catch(e){fail(e);}finally{lock.current=false;if(alive.current)setBusy(false);}};
 const clearEditor=()=>{setEditing(false);setWorking(null);setBaseline('');};
 const loadDefinition=async(item:TriggerItem)=>{const token=++epoch.current,value=await triggerApi.definition(tab.sessionId,tab.database,item);if(!alive.current||token!==epoch.current)return;setSelected(item);setDefinition(value);clearEditor();};
 const refresh=async(wanted?:string)=>{
  const token=++epoch.current;const [value,list]=await Promise.all([triggerApi.catalog(tab.sessionId,tab.database),api.listTables(tab.sessionId,tab.database)]);
  if(!alive.current||token!==epoch.current)return;
  const options=value.targets??list.filter(t=>t.kind==='table'||session?.engine!=='mysql').map(t=>({name:t.name,schema:t.schema??null,kind:t.kind}));
  setCatalog(value);setTargets(options);const previous=latest.current.selected,key=wanted??(previous?triggerKey(previous):'');const item=value.items.find(t=>triggerKey(t)===key);
  if(item)await loadDefinition(item);else{setSelected(null);setDefinition(null);clearEditor();}
 };
 useEffect(()=>{alive.current=true;let cancelled=false;queueMicrotask(()=>{if(!cancelled)void run(()=>refresh());});return()=>{cancelled=true;alive.current=false;++epoch.current;};},[tab.id,tab.sessionId,tab.database]);
 const makeChange=(remove=false):TriggerChange=>{
  if(!canWrite)throw Error(readOnly?'只读会话不能修改触发器':'当前会话限制了数据库范围，不支持写入可能访问其他对象的触发器');
  const value=latest.current;
  if(remove){if(!value.selected||!value.definition)throw Error('请选择触发器');return {sessionId:tab.sessionId,database:tab.database,name:value.selected.name,table:value.selected.table,schema:value.selected.schema??null,draft:null,original:value.definition.sql,confirmed:false};}
  const w=value.working,target=value.targets.find(t=>targetKey(t)===w?.target);
  if(!w?.name.trim()||!target)throw Error('请填写触发器名称并选择所属对象');
  if(!w.draft.events.length)throw Error('请选择触发事件');
  if(session?.engine==='postgres'?!w.draft.functionName:!w.draft.body.trim())throw Error(session?.engine==='postgres'?'请选择触发器函数':'请填写触发器主体');
  return {sessionId:tab.sessionId,database:tab.database,name:w.name.trim(),table:target.name,schema:target.schema??null,draft:w.draft,original:value.selected?value.definition?.sql??null:null,confirmed:false};
 };
 const applyChange=async(change:TriggerChange)=>{
  if(lock.current)throw Error('请等待当前操作完成');lock.current=true;setBusy(true);setError('');
  try{await triggerApi.apply(change);if(!alive.current)return;clearEditor();setSelected(null);setDefinition(null);setNotice(change.draft?'触发器已保存':'触发器已删除');
   try{await refresh(change.draft?triggerKey(change):'');}catch(e){fail(Error('变更已执行，但刷新失败：'+normalizeError(e).message));}
  }finally{lock.current=false;if(alive.current)setBusy(false);}
 };
 const previewCurrent=async()=>{const p=await triggerApi.preview(makeChange());return p.statements;};
 usePendingEdit({tabId:tab.id,sessionId:tab.sessionId,label:'触发器定义',preview:previewCurrent,save:()=>applyChange(makeChange()),discard:clearEditor,busy:()=>busy},dirty||busy);
 const beginConfirm=(remove=false)=>{try{setError('');setWarning(session?.engine==='mysql'?'触发器变更可能影响后续数据写入；MySQL / MariaDB 替换采用 DROP + CREATE，不能保证整体回滚。':'触发器变更可能影响后续数据写入，请核对对象、时机和事件。');setPending(makeChange(remove));}catch(e){fail(e);}};
 useShortcut('save',()=>{if(editing&&dirty&&!busy)beginConfirm();},active,35);
 const navigate=(work:()=>Promise<void>)=>void (async()=>{if(await confirmEdits(e=>e.tabId===tab.id))await run(work);})();
 const startNew=()=>navigate(async()=>{const target=targets.find(allowedTarget);const w:Working={name:'',target:target?targetKey(target):'',draft:newTriggerDraft(target?.kind==='view')};setSelected(null);setDefinition(null);setWorking(w);setBaseline(JSON.stringify(w));setEditing(true);setNotice('');});
 const startEdit=()=>{if(!selected||!definition?.draft)return;const w={name:selected.name,target:targetKey({name:selected.table,schema:selected.schema}),draft:structuredClone(definition.draft)};setWorking(w);setBaseline(JSON.stringify(w));setEditing(true);setNotice('');};
 const changeDraft=(patch:Partial<TriggerDraft>)=>setWorking(w=>w?{...w,draft:{...w.draft,...patch}}:w);
 const openQuery=(sql:string)=>{useTabStore.getState().openQuery(tab.sessionId,tab.database,id=>updateDraft(id,{sessionId:tab.sessionId,database:tab.database,sql,name:'触发器定义',updatedAt:new Date().toISOString()}));};
 const functionTemplate=()=>{const schema=currentTarget?.schema??tab.schema??'public';openQuery(`CREATE FUNCTION "${schema.replace(/"/g,'""')}"."trigger_function_name"()\nRETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  -- 编写触发器逻辑；DELETE 事件通常返回 OLD。\n  RETURN NEW;\nEND;\n$$;`);};
 const editorValue=editing&&working&&session?.engine!=='postgres'?working.draft.body:definition?.sql??'';
 return <section className="dw-triggers" aria-label="触发器工作区">
  <header className="dw-triggers-toolbar"><strong><FlashRegular/> 触发器 · {tab.database}</strong>{tab.table&&<><span className="dw-triggers-context">{targetLabel({name:tab.table,schema:tab.schema})}</span><Button size="small" appearance="subtle" onClick={()=>useTabStore.getState().openTriggers(tab.sessionId,tab.database)}>查看全部</Button></>}<Input size="small" aria-label="搜索触发器" placeholder="名称 / 表 / 事件" contentBefore={<SearchRegular/>} value={search} onChange={(_,d)=>setSearch(d.value)}/><Button size="small" icon={<ArrowClockwiseRegular/>} disabled={busy} onClick={()=>navigate(()=>refresh())}>刷新</Button><Button size="small" icon={<AddRegular/>} disabled={busy||!canWrite} onClick={startNew}>新增触发器</Button></header>
  {(readOnly||restricted)&&<div className="dw-triggers-hint">{readOnly?'只读会话：可查看和复制触发器定义。':'此会话限制了数据库范围：触发器可能访问其他对象，当前仅支持查看。'}</div>}
  {error&&<div role="alert" className="dw-triggers-error">{error}</div>}{notice&&<div role="status" className="dw-triggers-hint">{notice}</div>}
  <div className="dw-triggers-body"><aside className="dw-triggers-list" aria-label="触发器列表"><div className="dw-triggers-list-title">{items.length} 个触发器{busy&&<Spinner size="tiny"/>}</div><div className="dw-triggers-list-scroll"><ResizableSchemaTable engine={session?.engine??'mysql'} kind="triggers" size="small" aria-label="触发器列表表格"><TableHeader><TableRow><ResizableHeaderCell columnKey="name" style={{width:200}}>名称</ResizableHeaderCell><ResizableHeaderCell columnKey="target" style={{width:160}}>所属对象</ResizableHeaderCell><ResizableHeaderCell columnKey="timing" style={{width:110}}>时机</ResizableHeaderCell><ResizableHeaderCell columnKey="event" style={{width:100}}>事件</ResizableHeaderCell>{session?.engine==='postgres'&&<ResizableHeaderCell columnKey="enabled" style={{width:70}}>状态</ResizableHeaderCell>}</TableRow></TableHeader><TableBody>{items.map(t=><TableRow key={triggerKey(t)} data-selected={selected&&triggerKey(t)===triggerKey(selected)} onClick={()=>{if(!busy)navigate(()=>loadDefinition(t));}}><TableCell><button className="dw-trigger-name" disabled={busy} aria-current={selected&&triggerKey(t)===triggerKey(selected)?'true':undefined} onClick={e=>{e.stopPropagation();navigate(()=>loadDefinition(t));}}>{t.name}</button></TableCell><TableCell title={targetLabel({name:t.table,schema:t.schema})}>{targetLabel({name:t.table,schema:t.schema})}</TableCell><TableCell><span className="dw-trigger-token timing">{t.timing}</span></TableCell><TableCell><span className="dw-trigger-token event">{t.event}</span></TableCell>{session?.engine==='postgres'&&<TableCell>{({O:'启用',D:'停用',A:'始终',R:'副本'} as Record<string,string>)[t.enabled??'']??t.enabled??'—'}</TableCell>}</TableRow>)}</TableBody></ResizableSchemaTable>{!busy&&!items.length&&<div className="dw-triggers-empty">{search?'没有匹配的触发器':'暂无可见触发器'}</div>}</div></aside>
   <section className="dw-triggers-editor" aria-label="触发器详情"><header className="dw-triggers-editor-toolbar"><strong>{editing?(selected?'编辑触发器':'新增触发器'):selected?.name??'定义'}</strong><span className="dw-triggers-spacer"/>{!editing&&selected&&<><Button size="small" icon={<EditRegular/>} disabled={busy||!canWrite||!definition?.draft} onClick={startEdit}>编辑</Button><Button size="small" icon={<DeleteRegular/>} disabled={busy||!canWrite||!definition} onClick={()=>beginConfirm(true)}>删除</Button></>}{editing&&<><Button size="small" icon={<SaveRegular/>} appearance="primary" disabled={busy||!dirty||!canWrite} onClick={()=>beginConfirm()}>保存</Button><Button size="small" icon={<ArrowUndoRegular/>} disabled={busy} onClick={clearEditor}>废弃</Button></>}{definition&&!editing&&<><Button size="small" icon={<CopyRegular/>} onClick={()=>void navigator.clipboard.writeText(definition.sql).catch(fail)}>复制定义</Button><Button size="small" icon={<CodeRegular/>} onClick={()=>openQuery(definition.sql)}>在查询中打开</Button></>}</header>
   {definition?.warning&&<div className="dw-triggers-hint">{definition.warning}</div>}
   {editing&&working&&<div className="dw-triggers-form"><label>名称<Input size="small" aria-label="触发器名称" value={working.name} disabled={busy||!!selected} onChange={(_,d)=>setWorking(w=>w?{...w,name:d.value}:w)}/></label><label>所属对象<Select size="small" aria-label="触发器所属对象" value={working.target} disabled={busy||!!selected} onChange={(_,d)=>{const target=targets.find(t=>targetKey(t)===d.value);setWorking(w=>w?{...w,target:d.value,draft:{...w.draft,timing:target?.kind==='view'?'INSTEAD OF':'AFTER',orientation:'ROW',events:['INSERT']}}:w);}}><option value="">请选择</option>{targets.filter(allowedTarget).map(t=><option key={targetKey(t)} value={targetKey(t)}>{targetLabel(t)}{t.kind==='view'?' · 视图':''}</option>)}</Select></label><label>时机<Select size="small" aria-label="触发时机" value={working.draft.timing} disabled={busy} onChange={(_,d)=>changeDraft({timing:d.value as TriggerDraft['timing'],...(d.value==='INSTEAD OF'?{orientation:'ROW',events:working.draft.events.filter(v=>v!=='TRUNCATE')}:currentTarget?.kind==='view'?{orientation:'STATEMENT'}:{})})}>{(currentTarget?.kind==='view'?(session?.engine==='postgres'?['BEFORE','AFTER','INSTEAD OF']:['INSTEAD OF']):['BEFORE','AFTER']).map(v=><option key={v} value={v}>{v} · {v==='BEFORE'?'之前':v==='AFTER'?'之后':'替代'}</option>)}</Select></label>
   {session?.engine==='postgres'&&<label>执行粒度<Select size="small" aria-label="执行粒度" value={working.draft.orientation} disabled={busy||working.draft.timing==='INSTEAD OF'||currentTarget?.kind==='view'} onChange={(_,d)=>changeDraft({orientation:d.value as TriggerDraft['orientation'],events:d.value==='ROW'?working.draft.events.filter(v=>v!=='TRUNCATE'):working.draft.events})}><option value="ROW">ROW · 每行</option><option value="STATEMENT">STATEMENT · 每条语句</option></Select></label>}
   <div className="dw-triggers-events"><span>事件</span>{session?.engine!=='postgres'?<Select size="small" aria-label="触发事件" disabled={busy} value={working.draft.events[0]??'INSERT'} onChange={(_,d)=>changeDraft({events:[d.value]})}>{['INSERT','UPDATE','DELETE'].map(v=><option key={v} value={v}>{v}</option>)}</Select>:['INSERT','UPDATE','DELETE',...(currentTarget?.kind!=='view'&&working.draft.orientation==='STATEMENT'?['TRUNCATE']:[])].map(v=><Checkbox key={v} size="medium" label={v} disabled={busy} checked={working.draft.events.includes(v)} onChange={(_,d)=>changeDraft({events:d.checked?[...working.draft.events,v]:working.draft.events.filter(x=>x!==v)})}/>)}</div>
   {session?.engine==='postgres'?<label className="dw-triggers-function">触发器函数<Select size="small" aria-label="触发器函数" disabled={busy} value={working.draft.functionName?JSON.stringify([working.draft.functionSchema,working.draft.functionName]):''} onChange={(_,d)=>{const value=d.value?JSON.parse(d.value):[null,null];changeDraft({functionSchema:value[0],functionName:value[1]});}}><option value="">选择已有的无参 trigger 函数</option>{catalog.functions.map(f=><option key={JSON.stringify([f.schema,f.name])} value={JSON.stringify([f.schema,f.name])}>{f.schema}.{f.name}()</option>)}</Select></label>:<Button size="small" disabled={busy||!!working.draft.body.trim()} onClick={()=>changeDraft({body:session?.engine==='mysql'?'BEGIN\n  DO 0;\nEND':'BEGIN\n  SELECT 1;\nEND'})}>填入空操作示例</Button>}
   </div>}
   {editing&&session?.engine==='postgres'?<div className="dw-triggers-pg"><p>触发器通过函数执行逻辑，保存前可预览完整 SQL。</p>{!catalog.functions.length&&<p>当前没有可选的无参 trigger 函数。</p>}<Button size="small" icon={<CodeRegular/>} onClick={functionTemplate}>在查询中新建触发器函数</Button></div>:<div className="dw-triggers-code">{!selected&&!editing?<div className="dw-triggers-empty">选择触发器查看定义，或点击“新增触发器”。</div>:<Editor height="100%" language="sql" value={editorValue} onChange={v=>{if(editing)changeDraft({body:v??''});}} theme={theme.name} beforeMount={theme.beforeMount} options={{ariaLabel:editing?'触发器主体':'触发器 SQL 定义',readOnly:!editing||busy||!canWrite,minimap:{enabled:false},fontSize:12,lineHeight:18,automaticLayout:true,scrollBeyondLastLine:false,wordWrap:'on',unicodeHighlight:{ambiguousCharacters:false,invisibleCharacters:false}}}/>}</div>}
   </section></div>
  <footer className="dw-triggers-footer"><span>{catalog.version}</span><span>{editing?'编辑完成后保存并预览确认；仅保存后生效':'列表和定义受服务器权限限制'}</span></footer>
  <ConfirmSqlDialog open={!!pending} tabId={tab.id} sessionId={tab.sessionId} title={pending?.draft?(pending.original?'保存触发器':'新增触发器'):'删除触发器'} description={pending?`${tab.database}.${pending.schema?pending.schema+'.':''}${pending.table} · ${pending.name}`:''} warning={warning} loadPreview={async()=>{if(!pending)return [];const value=await triggerApi.preview(pending);if(previewRequest.current===pending)setWarning(value.warning||warning);return value.statements;}} onApply={async()=>{if(pending)await applyChange(pending);}} onDone={()=>setPending(null)} onClose={()=>setPending(null)}/>
 </section>;
}
