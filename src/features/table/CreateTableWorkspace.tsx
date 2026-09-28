import {useEffect,useRef,useState} from 'react';
import Editor from '@monaco-editor/react';
import {Button,Input,Field,Spinner,Table,TableHeader,TableHeaderCell,TableRow,TableBody,MenuList,MenuItem} from '@fluentui/react-components';
import {AddRegular,SaveRegular,DismissRegular} from '@fluentui/react-icons';
import {api,normalizeError} from '../../ipc';
import type {ColumnMeta,TableInfo} from '../../ipc/types';
import {useTabStore,type CreateTableTab,type TableTab,type TableView} from '../../stores/useTabStore';
import {useSessionStore} from '../../stores/useSessionStore';
import {useExplorerStore} from '../../stores/useExplorerStore';
import {usePendingEdit} from '../../stores/useEditGuard';
import {useNotify} from '../../app/toast';
import {ContextMenuPortal,ContextMenuSurface} from '../../app/ContextMenuPortal';
import {useEditorTheme} from '../../useEditorTheme';
import {useTableWorkspaceStyles} from './TableWorkspace';
import {TableViewTabs} from './TableViewTabs';
import {TableOptionsEditor} from './TableOptionsEditor';
import {InlineColumnRow} from './InlineColumnRow';
import {DraftIndexes,DraftForeignKeys} from './DraftRelations';
import {draftSpec,newColumn,newTableState,updateDraftColumn,type CreateTableState} from './createTableDraft';
import {columnCapabilities} from './columnCapabilities';
import {ENGINE_COLORS} from '../sessions/engine';
import './create-table.css';

export function CreateTableWorkspace({tab}:{tab:CreateTableTab}){
 const styles=useTableWorkspaceStyles(),notify=useNotify(),theme=useEditorTheme();
 const session=useSessionStore(s=>s.sessions.find(v=>v.id===tab.sessionId));
 const engine=session?.engine??'sqlite',disabled=!session||session.readOnly;
 const [view,setView]=useState<TableView>('info'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[sql,setSql]=useState(''),[previewBusy,setPreviewBusy]=useState(false);
 const lock=useRef(false),draft=tab.draft,caps=columnCapabilities(engine);
 const [menu,setMenu]=useState<{x:number;y:number;id:string}|null>(null);
 const change=(next:CreateTableState)=>{if(disabled||lock.current)return;useTabStore.getState().updateCreateTable(tab.id,next);setError('');};
 const spec=()=>({type:'createTableDraft' as const,draft:draftSpec(draft,engine)});
 const reset=()=>{if(lock.current)return;useTabStore.getState().updateCreateTable(tab.id,newTableState(engine));setError('');setView('info');};
 const save=async()=>{
  if(disabled)throw Error('当前会话不允许创建表');if(lock.current)throw Error('正在保存建表草稿');
  lock.current=true;setBusy(true);setError('');
  try{
   const submitted=spec();await api.ddlApply(tab.sessionId,tab.database,submitted);
   useTabStore.getState().finishCreateTable(tab.id,submitted.draft.table,submitted.draft.schema??null);
   notify.success('表已创建',submitted.draft.table);
   void useExplorerStore.getState().loadTables(tab.sessionId,tab.database).catch(e=>notify.error(e,'表已创建，但列表刷新失败'));
  }catch(e){setError(normalizeError(e).message);throw e;}finally{lock.current=false;setBusy(false);}
 };
 const dirty=JSON.stringify(draft)!==JSON.stringify(newTableState(engine));
 usePendingEdit({tabId:tab.id,sessionId:tab.sessionId,label:'新建表',save,discard:reset,busy:()=>lock.current,preview:()=>api.ddlPreview(tab.sessionId,tab.database,spec())},dirty||busy,tab.id+':create');
 useEffect(()=>{
  if(view!=='ddl')return;let alive=true;setPreviewBusy(true);setSql('');
  void api.ddlPreview(tab.sessionId,tab.database,{type:'createTableDraft',draft:draftSpec(draft,engine)}).then(v=>{if(alive)setSql(v.join(';\n\n')+';');}).catch(e=>{if(alive)setSql('-- '+normalizeError(e).message.replace(/[\r\n]/g,' '));}).finally(()=>{if(alive)setPreviewBusy(false);});return()=>{alive=false;};
 },[view,draft,engine,tab.sessionId,tab.database]);
 const columns:ColumnMeta[]=draft.columns.map((c,i)=>({name:c.name,ordinal:i+1,rawType:c.dataType,canonical:{kind:'unknown',raw:c.dataType},nullable:c.nullable,autoIncrement:c.autoIncrement,unsigned:c.unsigned,comment:c.comment,defaultValue:c.defaultMode==='literal'?c.defaultValue:c.defaultMode==='null'?'NULL':c.defaultMode==='timestamp'?'CURRENT_TIMESTAMP':null}));
 const fakeTab:TableTab={id:tab.id,kind:'table',sessionId:tab.sessionId,database:tab.database,schema:draft.schema,table:draft.properties.name,title:'新建表*',view};
 const info:TableInfo={name:'',database:tab.database,kind:'table',columnCount:columns.length,indexCount:draft.indexes.length,foreignKeyCount:draft.foreignKeys.length,primaryKey:[],extra:{}};
 const addColumn=(at=draft.columns.length)=>{const columns=[...draft.columns];columns.splice(at,0,newColumn(engine));change({...draft,columns});setMenu(null);};
 const removeColumn=(id:string)=>{const c=draft.columns.find(c=>c.id===id);if(!c)return;if(draft.indexes.some(i=>i.columns.some(v=>v.name===c.name))||draft.foreignKeys.some(f=>f.columns.includes(c.name)||(f.selfReference&&f.refColumns.includes(c.name)))){setError('请先从索引和外键中移除此字段，再删除列。');return;}change({...draft,columns:draft.columns.filter(c=>c.id!==id)});};
 const menuIndex=menu?draft.columns.findIndex(c=>c.id===menu.id):-1;
 const move=(delta:number)=>{const columns=[...draft.columns];const [c]=columns.splice(menuIndex,1);columns.splice(menuIndex+delta,0,c);change({...draft,columns});setMenu(null);};
 return <div className={styles.root}>
 <div className={`${styles.header} dw-table-heading`}><span className={styles.engineDot} style={{backgroundColor:ENGINE_COLORS[engine]}}/><span className={styles.title}>{tab.database} · 新建表*</span><div className={styles.spacer}/><Button size="small" appearance="primary" icon={busy?<Spinner size="tiny"/>:<SaveRegular/>} disabled={disabled||busy} onClick={()=>void save().catch(()=>{})}>保存</Button><Button size="small" icon={<DismissRegular/>} disabled={busy||!dirty} onClick={reset}>废弃</Button></div>
 <TableViewTabs view={view} onSelect={setView} creating counts={{columns:columns.length,indexes:draft.indexes.length,foreignKeys:draft.foreignKeys.length}}/>
 {error&&<div className="dw-draft-error" role="alert">{error}</div>}
 <div className="dw-create-panel">
 <div style={{display:view==='info'?'block':'none'}}>{engine==='postgres'&&<Field size="small" label="模式（Schema）" className="dw-create-schema"><Input size="small" aria-label="模式" value={draft.schema} disabled={disabled||busy} onChange={(_,d)=>change({...draft,schema:d.value})}/></Field>}<TableOptionsEditor tab={fakeTab} info={info} onSaved={()=>{}} draft={{disabled:busy,value:draft.properties,setValue:value=>{const properties=typeof value==='function'?value(draft.properties):value;change({...draft,properties});}}}/></div>
 {view==='structure'&&<><div className="dw-draft-toolbar"><Button size="small" icon={<AddRegular/>} disabled={disabled||busy} onClick={()=>addColumn()}>添加列</Button><span className="dw-draft-hint">双击单元格编辑；右键插入、调整顺序或创建索引</span></div><Table className={'dw-schema-list dw-inline-columns'+(engine==='mysql'?'':' dw-inline-columns-standard')} size="extra-small" aria-label="列草稿"><TableHeader><TableRow>{['#','名称',engine==='sqlite'?'声明类型':'类型','长度/集合','可空',...(caps.unsigned?['无符号']:[]),'默认值','自动增长',...(caps.onUpdate?['ON UPDATE']:[]),'主键','注释','操作'].map(t=><TableHeaderCell key={t} style={{width:['#','可空','主键','操作'].includes(t)?50:['无符号','自动增长'].includes(t)?76:undefined}}>{t}</TableHeaderCell>)}</TableRow></TableHeader><TableBody>{draft.columns.map((c,i)=><InlineColumnRow key={c.id} column={columns[i]} engine={engine} creating primary={c.primaryKey} singlePrimary={draft.columns.filter(c=>c.primaryKey).length===1} edit={{nullable:c.nullable,dataType:c.dataType,newName:c.name,unsigned:c.unsigned,comment:c.comment,defaultMode:c.defaultMode,defaultValue:c.defaultValue,autoIncrement:c.autoIncrement,onUpdate:c.onUpdate}} disabled={disabled||busy} deleteDisabled={disabled||busy} onPrimaryChange={checked=>change(updateDraftColumn(draft,c.id,{primaryKey:checked,...(checked?{nullable:false}:{autoIncrement:engine==='sqlite'?false:c.autoIncrement})}))} onEdit={patch=>change(updateDraftColumn(draft,c.id,patch))} onDelete={()=>removeColumn(c.id)} onContextMenu={e=>{e.preventDefault();if(!disabled&&!busy)setMenu({x:e.clientX,y:e.clientY,id:c.id});}}/>)}</TableBody></Table>{!columns.length&&<p className="dw-draft-hint">点击“添加列”开始定义字段。</p>}</>}
 {view==='indexes'&&<DraftIndexes value={draft.indexes} onChange={indexes=>change({...draft,indexes})} columns={columns} engine={engine} disabled={disabled||busy}/>}
 {view==='foreignKeys'&&<DraftForeignKeys value={draft.foreignKeys} onChange={foreignKeys=>change({...draft,foreignKeys})} columns={columns} engine={engine} sessionId={tab.sessionId} database={tab.database} schema={draft.schema} disabled={disabled||busy}/>}
 {view==='ddl'&&(previewBusy?<Spinner size="tiny" label="生成建表 SQL…"/>:<div style={{height:'100%',minHeight:260}}><Editor value={sql} language="sql" theme={theme.name} beforeMount={theme.beforeMount} options={{readOnly:true,automaticLayout:true,minimap:{enabled:false},fontSize:13,scrollBeyondLastLine:false}}/></div>)}
 </div>
 {menu&&menuIndex>=0&&<ContextMenuPortal><div className="dw-draft-menu-overlay" onClick={()=>setMenu(null)} onContextMenu={e=>{e.preventDefault();setMenu(null);}}/><ContextMenuSurface x={menu.x} y={menu.y} className="dw-draft-menu"><MenuList><MenuItem onClick={()=>addColumn(menuIndex)}>在上方添加</MenuItem><MenuItem onClick={()=>addColumn(menuIndex+1)}>在下方添加</MenuItem><MenuItem disabled={menuIndex===0} onClick={()=>move(-1)}>向上移动</MenuItem><MenuItem disabled={menuIndex===columns.length-1} onClick={()=>move(1)}>向下移动</MenuItem><MenuItem disabled={!columns[menuIndex].name} onClick={()=>{change({...draft,indexes:[...draft.indexes,{name:'idx_'+columns[menuIndex].name,columns:[{name:columns[menuIndex].name}],unique:false}]});setView('indexes');setMenu(null);}}>创建索引</MenuItem>{draft.indexes.map((index,i)=><MenuItem key={i} disabled={!columns[menuIndex].name||index.columns.some(c=>c.name===columns[menuIndex].name)} onClick={()=>{change({...draft,indexes:draft.indexes.map((v,at)=>at===i?{...v,columns:[...v.columns,{name:columns[menuIndex].name}]}:v)});setMenu(null);}}>加入索引：{index.name||i+1}</MenuItem>)}<MenuItem onClick={()=>{removeColumn(menu.id);setMenu(null);}}>删除列</MenuItem></MenuList></ContextMenuSurface></ContextMenuPortal>}
 </div>;
}
